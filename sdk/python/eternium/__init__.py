"""
Eternium SDK — Python
AI image & video generation. One call, one result.

Usage:
    from eternium import Eternium

    client = Eternium("etrn_your_key")
    result = client.image("A futuristic city at sunset")
    print(result["url"])  # direct download URL
"""

from .client import Eternium, EterniumError

__all__ = ["Eternium", "EterniumError"]
__version__ = "1.0.0"
