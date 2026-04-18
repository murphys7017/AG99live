import logging

from astrbot.api.star import Context, Star


class MyPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        from .adapter.plugin_runtime import set_plugin_config, set_plugin_context

        self.context = context
        self.config = config if config is not None else {}

        _configure_noisy_loggers()
        set_plugin_context(context)
        set_plugin_config(self.config)

        # Import solely for side effect: the class decorator registers the adapter.
        from .platform_adapter import OLVPetPlatformAdapter  # noqa: F401


def _configure_noisy_loggers() -> None:
    for logger_name in (
        "pyffmpeg",
        "pyffmpeg.FFmpeg",
        "pyffmpeg.misc.Paths",
    ):
        logging.getLogger(logger_name).setLevel(logging.CRITICAL)
