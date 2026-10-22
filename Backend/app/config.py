from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    use_sqlite: bool = False  # dev/testing convenience - bypasses MySQL entirely
    db_username: str = "root"
    db_password: str = "root"
    db_host: str = "localhost"
    db_port: int = 3306
    db_name: str = "centry_db"

    # Auth
    # ⚠️ CHANGE THIS in production - generate with: openssl rand -hex 32
    jwt_secret_key: str = "CHANGE-ME-dev-only-insecure-default-secret-key"
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 60 * 24  # 24 hours

    # OAuth (platform connections)
    # Your backend's public base URL - used to build each platform's redirect_uri.
    # Must exactly match what's registered in each platform's developer/partner console.
    oauth_redirect_base_url: str = "http://localhost:8000"
    oauth_state_expire_minutes: int = 10  # how long a user has to complete the OAuth flow

    # Frontend
    # Origins the browser is allowed to call this API from. The pages are
    # served by this app itself (see the "Frontend" section in app/main.py),
    # which is same-origin and needs no CORS at all - these are for running
    # the pages from a separate dev server or file:// instead.
    # Override with JSON, e.g. CENTRY_CORS_ALLOWED_ORIGINS='["https://app.example.com"]'
    cors_allowed_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "null",  # pages opened directly from disk (file://)
    ]

    # Shopee Open Platform (open.shopee.com)
    shopee_partner_id: str = ""
    shopee_partner_key: str = ""
    shopee_base_url: str = "https://partner.shopeemobile.com"  # sandbox: partner.test-stable.shopeemobile.com

    # Lazada Open Platform (open.lazada.com)
    lazada_app_key: str = ""
    lazada_app_secret: str = ""

    # TikTok Shop Partner Center (partner.tiktokshop.com)
    # ⚠️ Endpoint details below are unverified - see app/core/oauth/tiktok_shop.py
    tiktok_shop_app_key: str = ""
    tiktok_shop_app_secret: str = ""
    tiktok_shop_service_id: str = ""

    # Meta for Developers (developers.facebook.com) - connects a Facebook
    # Page the MSME owner manages, for social-media activity telemetry.
    meta_app_id: str = ""
    meta_app_secret: str = ""

    # RabbitMQ - real-time dashboard "page events" 
    # (webhook telemetry in, behavioral trust score / incident updates out).
    # Distinct from /ws/live-verify, which streams audio directly with no
    # broker involved. This one goes through RabbitMQ so that *any* backend
    # process (a webhook handler, a background worker, the AI team's own
    # service) can publish an event without needing a direct handle on
    # whichever uvicorn worker holds a given user's open WebSocket - the
    # broker fans it out to whichever worker needs it.
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672/"
    # Topic exchange - routing keys are "user.<user_id>.<event_type>", so a
    # dashboard WebSocket can bind to "user.<id>.#" and get everything for
    # that user, while a future admin/ops view could bind to "user.*.<type>".
    rabbitmq_events_exchange: str = "centry.dashboard_events"
    # If RabbitMQ is unreachable (not running locally yet, etc.), log and
    # keep the API up rather than failing every request - set false once
    # RabbitMQ is a hard dependency in an environment.
    rabbitmq_optional: bool = True

    @property
    def database_url(self) -> str:
        if self.use_sqlite:
            return "sqlite:///./centry_dev.db"
        return (
            f"mysql+pymysql://{self.db_username}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    class Config:
        env_file = ".env"
        env_prefix = "CENTRY_"


settings = Settings()
