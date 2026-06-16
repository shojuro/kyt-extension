"""KYT × LongMemEval benchmark harness.

Adapts the official LongMemEval (V1) dataset to KYT's edge-function retrieval API:
ingest each instance's haystack as an isolated synthetic user, query with the
question, score with LongMemEval's own GPT-4o judge.
"""
