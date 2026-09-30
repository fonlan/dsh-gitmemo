"""gitmemo memory backend adapter for OmniMemEval.

gitmemo (`dsh-gitmemo`) is a local, git-backed long-term memory engine written
in TypeScript: every memory is an immutable markdown file committed into a
`.mem` git repository, and recall is a fixed-string OR grep over the
commit-message projections (title / summary / keywords) — entry bodies are
never scanned.

Because the engine is Node and this pipeline is Python, the adapter is a thin
JSON-lines client over a persistent Node bridge (`bridge.mjs`, spawned lazily
and spoken to on stdin/stdout — no HTTP server, no port). All gitmemo-specific
work lives on the Node side, where the real engine and the keyword strategy
live, so this file stays transport-only.

Interface mapping
-----------------
* ``add(messages, user_id, ...)``  → one memory entry per session, written with
  keywords chosen by the bridge (gitmemo requires 2–12 keywords at write time).
* ``search(query, user_id, top_k)`` → keywords are extracted from the natural
  language question by the bridge, then `mem_search` + `mem_read` return the
  top-k memory bodies as plain text.
* ``delete(user_id)``               → drops that user's `.mem` repository.

One repository per ``user_id`` keeps benchmark conversations isolated; state is
on disk, so a later pipeline step (a fresh Python process) reattaches instead of
re-ingesting.

Environment variables (all optional):
    GITMEMO_BRIDGE_PATH        path to bridge.mjs (default: next to this file)
    GITMEMO_NODE_BIN           node executable (default: node)
    GITMEMO_BRIDGE_SHARDS      concurrent bridge processes, routed by user_id (default: 4)
    GITMEMO_RPC_TIMEOUT        seconds per RPC before failing (default: 900)
    GITMEMO_LME_BASE_DIR       where per-user `.mem` repos live
    GITMEMO_LME_INGEST_KEYWORDS  idf | llm
    GITMEMO_LME_QUERY_KEYWORDS   plain | idf | llm
    GITMEMO_LME_INGEST_TEXT      user | all
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path

from .base_client import env_int, env_str


class _Bridge:
    """One persistent `bridge.mjs` process, safe for concurrent callers."""

    def __init__(self, argv: list[str], env: dict, timeout: float, label: str):
        self.argv = argv
        self.env = env
        self.timeout = timeout
        self.label = label
        self._proc: subprocess.Popen | None = None
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._stderr: list[str] = []
        self._lock = threading.Lock()
        self._seq = 0

    # ── process lifecycle ────────────────────────────────────────────────

    def _spawn(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return
        self._proc = subprocess.Popen(
            self.argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=self.env,
        )
        self._lines = queue.Queue()
        self._stderr = []
        threading.Thread(target=self._read_stdout, args=(self._proc,), daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(self._proc,), daemon=True).start()

    def _read_stdout(self, proc: subprocess.Popen) -> None:
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                self._lines.put(line)
        finally:
            self._lines.put(None)

    def _read_stderr(self, proc: subprocess.Popen) -> None:
        try:
            for line in proc.stderr:  # type: ignore[union-attr]
                self._stderr.append(line.rstrip())
                del self._stderr[:-40]
        except Exception:  # pragma: no cover - diagnostics only
            pass

    def _readline(self, deadline: float) -> str:
        remaining = max(deadline - time.monotonic(), 0.1)
        try:
            line = self._lines.get(timeout=remaining)
        except queue.Empty:
            raise TimeoutError(
                f"gitmemo bridge {self.label}: no response within {self.timeout:.0f}s"
            ) from None
        if line is None:
            detail = "\n".join(self._stderr[-8:])
            raise RuntimeError(
                f"gitmemo bridge {self.label} exited unexpectedly"
                + (f":\n{detail}" if detail else "")
            )
        return line

    # ── RPC ──────────────────────────────────────────────────────────────

    def call(self, cmd: str, params: dict, *, retry: bool = True) -> dict:
        with self._lock:
            self._seq += 1
            request_id = self._seq
            payload = json.dumps({"id": request_id, "cmd": cmd, "params": params})
            for attempt in (0, 1) if retry else (0,):
                try:
                    self._spawn()
                    proc = self._proc
                    assert proc is not None and proc.stdin is not None
                    proc.stdin.write(payload + "\n")
                    proc.stdin.flush()
                    deadline = time.monotonic() + self.timeout
                    while True:
                        line = self._readline(deadline)
                        stripped = line.strip()
                        if not stripped:
                            continue
                        try:
                            response = json.loads(stripped)
                        except json.JSONDecodeError:
                            # Not a protocol line (e.g. a stray print) — ignore.
                            continue
                        if response.get("id") != request_id:
                            continue
                        if not response.get("ok"):
                            raise RuntimeError(
                                f"gitmemo bridge {self.label} {cmd} failed: {response.get('error')}"
                            )
                        return response.get("result") or {}
                except (BrokenPipeError, RuntimeError, TimeoutError) as exc:
                    if attempt == 1:
                        raise
                    detail = "\n".join(self._stderr[-8:])
                    print(
                        f"  ⚠ gitmemo bridge {self.label} call failed ({exc}); restarting"
                        + (f"\n{detail}" if detail else "")
                    )
                    self._terminate()
            raise RuntimeError("unreachable")

    def _terminate(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.kill()
        except Exception:  # pragma: no cover - best effort
            pass

    def close(self) -> None:
        with self._lock:
            self._terminate()


class GitMemoClient:
    """OmniMemEval memory client backed by the local gitmemo engine."""

    def __init__(self):
        here = Path(__file__).resolve().parent
        self.bridge_path = env_str("GITMEMO_BRIDGE_PATH", str(here / "bridge.mjs"))
        self.node_bin = env_str("GITMEMO_NODE_BIN", "node")
        self.shards = env_int("GITMEMO_BRIDGE_SHARDS", 4, min_value=1) or 1
        self.timeout = float(env_int("GITMEMO_RPC_TIMEOUT", 900, min_value=1) or 900)
        self._bridges: dict[int, _Bridge] = {}
        self._init_lock = threading.Lock()

        if not Path(self.bridge_path).is_file():
            raise FileNotFoundError(
                f"gitmemo bridge not found at {self.bridge_path}; "
                "set GITMEMO_BRIDGE_PATH or install the adapter next to bridge.mjs"
            )

    # ── plumbing ─────────────────────────────────────────────────────────

    def _shard_for(self, user_id: str) -> int:
        digest = hashlib.sha1(str(user_id).encode("utf-8")).hexdigest()
        return int(digest[:8], 16) % self.shards

    def _bridge(self, user_id: str) -> _Bridge:
        index = self._shard_for(user_id)
        bridge = self._bridges.get(index)
        if bridge is None:
            with self._init_lock:
                bridge = self._bridges.get(index)
                if bridge is None:
                    bridge = _Bridge(
                        [self.node_bin, self.bridge_path],
                        env=dict(os.environ),
                        timeout=self.timeout,
                        label=f"shard-{index}",
                    )
                    self._bridges[index] = bridge
        return bridge

    def _call(self, user_id: str, cmd: str, params: dict) -> dict:
        return self._bridge(user_id).call(cmd, params)

    # ── OmniMemEval interface ────────────────────────────────────────────

    def add(self, messages, user_id, **kwargs):
        session_id = (
            kwargs.get("session_key")
            or kwargs.get("conv_id")
            or kwargs.get("session_id")
        )
        timestamp = kwargs.get("timestamp")
        payload_messages = [
            {
                "role": str(message.get("role", "user")),
                "content": str(message.get("content", "")),
                "chat_time": message.get("chat_time"),
            }
            for message in messages
        ]
        if timestamp is None:
            for message in payload_messages:
                if message.get("chat_time"):
                    timestamp = message["chat_time"]
                    break
        return self._call(
            user_id,
            "add",
            {
                "user_id": user_id,
                "session_id": session_id,
                "messages": payload_messages,
                "timestamp": timestamp,
            },
        )

    def search(self, query, user_id, top_k):
        """Return the retrieved memory bodies as a list of strings.

        `format_search_context` joins a list with newlines, so returning plain
        entry bodies keeps the answer LLM's context exactly as rich as the
        memories themselves (each body is the full session transcript).
        """
        result = self._call(
            user_id,
            "search",
            {"user_id": user_id, "query": query, "top_k": int(top_k)},
        )
        texts: list[str] = []
        for memory in result.get("memories", []):
            body = (memory.get("content") or "").strip()
            if not body:
                body = f"{memory.get('title', '')} {memory.get('summary', '')}".strip()
            if body:
                texts.append(body)
        return texts

    def search_debug(self, query, user_id, top_k):
        """Same call as `search` but returns the full bridge payload (diagnostics)."""
        return self._call(
            user_id,
            "search",
            {"user_id": user_id, "query": query, "top_k": int(top_k)},
        )

    def delete(self, user_id):
        """Drop this user's `.mem` repository (used by --clear and streaming)."""
        try:
            self._call(user_id, "delete", {"user_id": user_id})
            print(f"Deleted gitmemo memory for {user_id}")
        except Exception as exc:  # cleanup must never abort a run
            print(f"  ⚠ gitmemo delete failed for {user_id}: {exc}")

    def stats(self, user_id):
        return self._call(user_id, "stats", {"user_id": user_id})

    def close(self):
        for bridge in list(self._bridges.values()):
            bridge.close()
        self._bridges.clear()
