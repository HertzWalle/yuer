"""AstrBot 插件：把消息转发给 yuer 大脑的 `POST /turn`。

设计原则：这一层**只做传输**。人设、记忆、主动性、表情包、空间都在 yuer 里，
换接入层不换脑子；以后加平台只要 AstrBot 支持，不用改大脑。
"""

import aiohttp

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

REGISTERED_NAME = "yuer"
REGISTERED_AUTHOR = "HertzWalle"
REGISTERED_DESC = "把 yuer 大脑接进 AstrBot（只做接入层）"
REGISTERED_VERSION = "1.0.0"


@register(REGISTERED_NAME, REGISTERED_AUTHOR, REGISTERED_DESC, REGISTERED_VERSION)
class YuerAdapter(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.conf = config or {}

    # ------------------------------ 配置取值 ------------------------------

    def _url(self) -> str:
        return str(self.conf.get("turn_url") or "http://127.0.0.1:3030/turn").strip()

    def _headers(self) -> dict:
        token = str(self.conf.get("turn_token") or "").strip()
        return {"x-turn-token": token} if token else {}

    def _timeout(self) -> aiohttp.ClientTimeout:
        try:
            sec = int(self.conf.get("timeout_sec") or 120)
        except (TypeError, ValueError):
            sec = 120
        return aiohttp.ClientTimeout(total=max(5, sec))

    def _ignored(self, text: str) -> bool:
        prefixes = self.conf.get("ignore_prefixes") or ["/"]
        return any(text.startswith(str(p)) for p in prefixes if str(p))

    # ------------------------------ 消息映射 ------------------------------

    @staticmethod
    def _conv_of(event: AstrMessageEvent) -> str:
        """`group:<群号>` / `private:<用户号>`——和 yuer 的记忆分桶口径一致。"""
        group_id = ""
        try:
            group_id = str(event.get_group_id() or "")
        except Exception:  # 某些平台适配器没有群概念
            group_id = ""
        if group_id:
            return f"group:{group_id}"
        return f"private:{event.get_sender_id()}"

    # ------------------------------ 事件入口 ------------------------------

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        text = (event.message_str or "").strip()
        if not text or self._ignored(text):
            return

        payload = {
            "conv": self._conv_of(event),
            "user": {
                "id": str(event.get_sender_id()),
                "name": (event.get_sender_name() or "").strip(),
            },
            "text": text,
        }

        try:
            async with aiohttp.ClientSession(timeout=self._timeout()) as session:
                async with session.post(self._url(), json=payload, headers=self._headers()) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.warning(f"[yuer] /turn 返回 {resp.status}：{body[:200]}")
                        return
                    data = await resp.json()
        except Exception as exc:  # 网络/超时都不该让 AstrBot 崩
            logger.warning(f"[yuer] 调 /turn 失败：{exc}")
            return

        segments = data.get("segments") or []
        if not segments and data.get("text"):
            segments = [data["text"]]

        # 逐条 yield：AstrBot 会把每条 plain_result 当成一条独立消息发出去（≈ 我们的多气泡）
        for seg in segments:
            seg = str(seg).strip()
            if seg:
                yield event.plain_result(seg)

    async def terminate(self):
        """插件卸载时没有需要释放的资源。"""
        return
