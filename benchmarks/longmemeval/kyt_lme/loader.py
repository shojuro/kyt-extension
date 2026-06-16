"""Streaming loader for LongMemEval JSON.

The dataset is a single top-level JSON array of instances. longmemeval_m is
~2.7 GB, so we stream one instance at a time with ijson rather than loading the
whole file into memory.
"""
import ijson


def iter_instances(path):
    """Yield each LongMemEval instance (dict) from a *_cleaned.json file."""
    with open(path, "rb") as f:
        for obj in ijson.items(f, "item"):
            yield obj


def count_instances(path):
    """Count instances without holding them all in memory."""
    n = 0
    for _ in iter_instances(path):
        n += 1
    return n
