"""Thin HTTP client for KYT's edge functions + PostgREST (service-role).

All calls authenticate as the service role (Bearer service_key) with the anon key
as the `apikey` gateway header — the trust model the edge functions enforce after
the 2026-06-11 service-role gating fix. Service role bypasses rate limits and may
act on the synthetic per-instance user_ids.
"""
import time
import requests


class KytClient:
    def __init__(self, url, service_key, anon_key, timeout=60):
        self.url = url.rstrip("/")
        self.service_key = service_key
        self.anon_key = anon_key
        self.timeout = timeout

    # ---- headers ----------------------------------------------------------
    def _fn_headers(self):
        return {
            "Authorization": f"Bearer {self.service_key}",
            "apikey": self.anon_key,
            "Content-Type": "application/json",
        }

    def _rest_headers(self, extra=None):
        h = {
            "Authorization": f"Bearer {self.service_key}",
            "apikey": self.service_key,
            "Content-Type": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def _post_fn(self, fn, body, retries=4):
        last = None
        for attempt in range(retries):
            try:
                r = requests.post(f"{self.url}/functions/v1/{fn}", json=body,
                                  headers=self._fn_headers(), timeout=self.timeout)
                if r.status_code < 500:
                    return r.status_code, _safe_json(r)
                last = (r.status_code, r.text)
            except requests.RequestException as e:
                last = (None, str(e))
            time.sleep(2 ** attempt)
        return last if last else (None, "unknown error")

    # ---- ingest -----------------------------------------------------------
    def save_batch(self, batch):
        """POST one save_chat_turn_batch body (skip_ai_processing=True)."""
        return self._post_fn("save_chat_turn_batch", batch)

    # ---- embeddings backfill ---------------------------------------------
    def backfill_embeddings_once(self):
        """Drive one backfill_embeddings invocation (~500 rows). Returns parsed body."""
        return self._post_fn("backfill_embeddings", {})

    def count_null_embeddings(self):
        """Global count of chat_turns with embedding IS NULL (dedicated project)."""
        return self._rest_count("chat_turns", {"embedding": "is.null"})

    # ---- query ------------------------------------------------------------
    def search(self, body):
        """POST search_memories. Omit `fast` -> full pipeline."""
        return self._post_fn("search_memories", body)

    # ---- PostgREST helpers ------------------------------------------------
    def _rest_count(self, table, filters):
        params = "&".join(f"{k}={v}" for k, v in filters.items())
        r = requests.get(
            f"{self.url}/rest/v1/{table}?{params}&select=id",
            headers=self._rest_headers({"Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"}),
            timeout=self.timeout,
        )
        # Content-Range: 0-0/<total>
        cr = r.headers.get("Content-Range", "")
        if "/" in cr:
            tail = cr.split("/")[-1]
            if tail.isdigit():
                return int(tail)
        return None

    def count_turns_for_user(self, user_id):
        return self._rest_count("chat_turns", {"user_id": f"eq.{user_id}"})

    def delete_user(self, user_id):
        """Cleanup: remove all chat_turns for a synthetic benchmark user."""
        r = requests.delete(
            f"{self.url}/rest/v1/chat_turns?user_id=eq.{user_id}",
            headers=self._rest_headers({"Prefer": "return=minimal"}),
            timeout=self.timeout,
        )
        return r.status_code


def _safe_json(resp):
    try:
        return resp.json()
    except Exception:
        return {"_raw": resp.text}
