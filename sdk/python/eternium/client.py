"""Eternium API client — handles generation, polling, caching, and pipelines."""

import time
import hashlib
import json
from typing import Optional
from urllib.request import Request, urlopen
from urllib.error import HTTPError

DEFAULT_BASE_URL = "https://api.eternium.ai"
DEFAULT_POLL_INTERVAL = 3.0
DEFAULT_TIMEOUT = 300.0


class EterniumError(Exception):
    """Raised when the Eternium API returns an error."""

    def __init__(self, message: str, code=None, data=None):
        super().__init__(message)
        self.code = code
        self.data = data or {}


class Eternium:
    """Eternium API client for AI image & video generation.

    Args:
        api_key: Your Eternium API key (etrn_...)
        base_url: API base URL (default: https://api.eternium.ai)
        poll_interval: Seconds between status polls (default: 3.0)
        timeout: Max seconds to wait for generation (default: 300)
        cache: Enable prompt caching for agent dedup (default: True)
        on_progress: Callback(dict) called on each poll
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        timeout: float = DEFAULT_TIMEOUT,
        cache: bool = True,
        on_progress=None,
    ):
        if not api_key:
            raise EterniumError("API key is required", code="MISSING_KEY")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.poll_interval = poll_interval
        self.timeout = timeout
        self.cache = cache
        self.on_progress = on_progress

    # ── Core request ──────────────────────────────────────────────

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        url = f"{self.base_url}{path}"
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self.api_key,
        }

        data = json.dumps(body).encode() if body else None
        req = Request(url, data=data, headers=headers, method=method)

        try:
            with urlopen(req) as resp:
                return json.loads(resp.read().decode())
        except HTTPError as e:
            try:
                err_data = json.loads(e.read().decode())
            except Exception:
                err_data = {}
            raise EterniumError(
                err_data.get("error", f"Request failed with status {e.code}"),
                code=e.code,
                data=err_data,
            )

    # ── Poll until done ───────────────────────────────────────────

    def _wait_for_task(self, task_id: str) -> dict:
        start = time.time()
        while time.time() - start < self.timeout:
            status = self._request("GET", f"/v1/tasks/{task_id}")
            task_status = (status.get("data") or status).get("status", "")

            if self.on_progress:
                self.on_progress({
                    "task_id": task_id,
                    "status": task_status,
                    "elapsed": time.time() - start,
                })

            if task_status in ("completed", "success"):
                try:
                    download = self._request("GET", f"/v1/tasks/{task_id}/download")
                    dl_data = download.get("data", download)
                    return {
                        "task_id": task_id,
                        "status": "completed",
                        "url": dl_data.get("url"),
                        "output": status.get("data", status),
                        "download": dl_data,
                    }
                except EterniumError:
                    return {
                        "task_id": task_id,
                        "status": "completed",
                        "output": status.get("data", status),
                    }

            if task_status in ("failed", "error"):
                err_msg = (status.get("data") or {}).get("error", "Unknown error")
                raise EterniumError(
                    f"Generation failed: {err_msg}",
                    code="GENERATION_FAILED",
                    data=status.get("data"),
                )

            time.sleep(self.poll_interval)

        raise EterniumError(f"Task {task_id} timed out after {self.timeout}s", code="TIMEOUT")

    # ── High-level generation ─────────────────────────────────────

    def image(
        self,
        prompt: str,
        model: str = "nano-banana-pro",
        wait: bool = True,
        **kwargs,
    ) -> dict:
        """Generate an image. Returns completed result with download URL.

        Args:
            prompt: What to generate
            model: nano-banana-pro, flux-kontext, or gpt4o-image
            wait: If True, polls until complete (default True)
            **kwargs: aspect_ratio, resolution, image_urls, callback_url, etc.
        """
        body = {"model": model, "prompt": prompt, "cache": self.cache, **kwargs}
        res = self._request("POST", "/v1/generate", body)

        if res.get("_cached"):
            return {**res, "cached": True}

        task_id = (res.get("data") or res).get("taskId") or res.get("taskId")
        if not task_id:
            return res

        if not wait:
            return {"task_id": task_id, "status": "submitted", "cost": res.get("_cost")}
        return self._wait_for_task(task_id)

    def video(
        self,
        prompt: str,
        model: str = "kling-3.0",
        wait: bool = True,
        **kwargs,
    ) -> dict:
        """Generate a video. Returns completed result with download URL.

        Args:
            prompt: What to generate
            model: kling-3.0, kling-2.6, or wan-2.6
            wait: If True, polls until complete (default True)
            **kwargs: duration, aspect_ratio, mode, sound, image_urls, etc.
        """
        body = {"model": model, "prompt": prompt, "cache": self.cache, **kwargs}
        res = self._request("POST", "/v1/generate", body)

        if res.get("_cached"):
            return {**res, "cached": True}

        task_id = (res.get("data") or res).get("taskId") or res.get("taskId")
        if not task_id:
            return res

        if not wait:
            return {"task_id": task_id, "status": "submitted", "cost": res.get("_cost")}
        return self._wait_for_task(task_id)

    def run_pipeline(
        self,
        pipeline: str,
        prompt: str,
        wait: bool = True,
        **kwargs,
    ) -> dict:
        """Run a multi-step pipeline. Returns all task results.

        Args:
            pipeline: product-shot, social-media-pack, video-ad, thumbnail-pack
            prompt: Base prompt for the pipeline
            wait: If True, polls all tasks until complete
        """
        body = {"pipeline": pipeline, "prompt": prompt, **kwargs}
        res = self._request("POST", "/v1/pipelines/run", body)

        if not wait or "tasks" not in res:
            return res

        results = []
        for task in res["tasks"]:
            if task.get("taskId") and task.get("status") == "submitted":
                try:
                    result = self._wait_for_task(task["taskId"])
                    results.append({**task, **result})
                except EterniumError as e:
                    results.append({**task, "error": str(e)})
            else:
                results.append(task)

        return {
            "pipeline": pipeline,
            "total_cost": res.get("total_cost"),
            "results": results,
        }

    # ── Info endpoints ────────────────────────────────────────────

    def list_models(self) -> dict:
        return self._request("GET", "/v1/models")

    def list_pipelines(self) -> dict:
        return self._request("GET", "/v1/pipelines")

    def list_tiers(self) -> dict:
        return self._request("GET", "/v1/tiers")

    def get_usage(self) -> dict:
        return self._request("GET", "/v1/usage")

    def get_task_status(self, task_id: str) -> dict:
        return self._request("GET", f"/v1/tasks/{task_id}")

    def get_download_url(self, task_id: str) -> dict:
        return self._request("GET", f"/v1/tasks/{task_id}/download")
