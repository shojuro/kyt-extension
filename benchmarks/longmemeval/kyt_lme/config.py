"""Config loader for the LongMemEval harness.

Reads benchmarks/longmemeval/.env (quote-stripped, like the auth-boundary test).
Real environment variables take precedence. API-phase keys are validated lazily
so the no-API paths (--dry, payload building) run without secrets.
"""
import os
from pathlib import Path

_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def _load_env_file():
    if not _ENV_PATH.exists():
        return
    for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip()
        # strip one layer of surrounding matching quotes (.env values may be quoted)
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        os.environ.setdefault(key, val)


_load_env_file()


def get(key, default=None, required=False):
    val = os.environ.get(key, default)
    if required and not val:
        raise SystemExit(
            f"Missing required config '{key}'. Set it in benchmarks/longmemeval/.env "
            f"(see .env.example)."
        )
    return val


def supabase():
    """(url, service_key, anon_key) for the dedicated benchmark project."""
    return (
        get("BENCH_SUPABASE_URL", required=True).rstrip("/"),
        get("BENCH_SERVICE_KEY", required=True),
        get("BENCH_ANON_KEY", required=True),
    )


def answer_model():
    return get("ANSWER_MODEL", "gpt-4o")


def openai_key():
    return get("OPENAI_API_KEY", required=True)


def longmemeval_repo():
    return get("LONGMEMEVAL_REPO", required=True)
