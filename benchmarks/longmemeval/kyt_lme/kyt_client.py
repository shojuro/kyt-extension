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

    def _post_fn(self, fn, body, retries=4, timeout=None):
        last = None
        for attempt in range(retries):
            try:
                r = requests.post(f"{self.url}/functions/v1/{fn}", json=body,
                                  headers=self._fn_headers(), timeout=timeout or self.timeout)
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
    def backfill_embeddings_once(self, user_id=None):
        """Drive one backfill_embeddings invocation. With user_id it processes
        only that user's null rows (enables parallel, non-overlapping fan-out).
        Long timeout, no retry (a retry would re-run the work)."""
        body = {"user_id": user_id} if user_id else {}
        return self._post_fn("backfill_embeddings", body, retries=1, timeout=240)

    def count_null_embeddings(self, user_id=None):
        """Count chat_turns with embedding IS NULL (optionally for one user)."""
        filters = {"embedding": "is.null"}
        if user_id:
            filters["user_id"] = f"eq.{user_id}"
        return self._rest_count("chat_turns", filters)

    # ---- entity backfill --------------------------------------------------
    def backfill_entities_once(self, user_id, max_rows=200, fast_mode=True):
        """Drive one backfill_entities invocation for a single user (Haiku entity
        extraction). Requires a real auth.users row for user_id (entities FK).
        Long timeout, no retry (a retry would re-extract already-done rows)."""
        body = {"user_id": user_id, "max_rows": max_rows, "fast_mode": fast_mode}
        return self._post_fn("backfill_entities", body, retries=1, timeout=300)

    def count_unextracted_turns(self, user_id):
        """Count a user's chat_turns not yet run through entity extraction."""
        return self._rest_count(
            "chat_turns",
            {"user_id": f"eq.{user_id}", "entities_extracted": "eq.false"},
        )

    def count_entities(self, user_id):
        """Count entities rows for a user (verifies extraction populated them)."""
        return self._rest_count("entities", {"user_id": f"eq.{user_id}"})

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

    def clear_retrieval_filters(self, user_id):
        """Set is_question=false, deflection=0 for a user's turns so fact-bearing
        turns that ALSO contain a question aren't excluded by the gravity RPC's
        is_question filter (LongMemEval messages routinely mix a fact with a
        trailing question — this filter otherwise drops ~63% of user turns)."""
        r = requests.patch(
            f"{self.url}/rest/v1/chat_turns?user_id=eq.{user_id}",
            headers=self._rest_headers({"Prefer": "return=minimal"}),
            json={"is_question": False, "deflection": 0},
            timeout=self.timeout,
        )
        return r.status_code

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
