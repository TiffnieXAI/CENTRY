import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import Base, engine
from app.core.exceptions import DuplicateResourceException, ResourceNotFoundException
from app.core.messaging.rabbitmq import close_rabbitmq, connect_rabbitmq
from app.routers import auth, oauth, verification, chat, events, webhooks

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# The static pages live next to this repo's Backend/ dir, not inside it:
#   <repo>/Backend/app/main.py  ->  <repo>/Frontend/pages/*.html
# Served at "/" at the very bottom of this file - see the "Frontend" section.
FRONTEND_DIR = Path(__file__).resolve().parents[2] / "Frontend" / "pages"


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.use_sqlite:
        # Sqlite is for convenience. 
        # Real (MySQL) schema changes go through Alembic instead: `alembic upgrade head`.
        Base.metadata.create_all(bind=engine)

    await connect_rabbitmq()
    try:
        yield
    finally:
        await close_rabbitmq()


app = FastAPI(
    title="Centry API",
    description="SAGE Centry - Base Authentication, User Schema, Platform OAuth, "
                 "Live Voice Verification, Real-Time Dashboard Events & Centry AI Chatbot",
    version="0.4.0",
    lifespan=lifespan,
)

# Browsers enforce a same-origin policy: a page served from
# http://localhost:5173 (or file://) can't call http://localhost:8000 unless
# the API opts in with these headers. When the pages are served by this same
# app (see the Frontend section below) this is a no-op, but it keeps the
# separate-dev-server / file:// workflow working.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_credentials=False,  # auth is a Bearer token in localStorage, not cookies
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(auth.router)
app.include_router(oauth.router)
app.include_router(verification.router)
app.include_router(chat.router)
app.include_router(events.router)
app.include_router(webhooks.router)


@app.exception_handler(DuplicateResourceException)
async def duplicate_handler(request: Request, exc: DuplicateResourceException):
    return JSONResponse(status_code=409, content={"message": exc.message})


@app.exception_handler(ResourceNotFoundException)
async def not_found_handler(request: Request, exc: ResourceNotFoundException):
    return JSONResponse(status_code=404, content={"message": exc.message})


@app.get("/health")
def health_check():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Frontend
#
# Serves Frontend/pages/*.html at "/" so the whole app runs on one origin
# (uvicorn app.main:app -> http://localhost:8000/landing.html) and the pages
# can call the API without any CORS/absolute-URL plumbing.
#
# Registered LAST on purpose: Starlette matches routes in order, so /docs,
# /openapi.json, /health, and every /api/v1/* route above win over the
# catch-all mount below.
# ---------------------------------------------------------------------------
if FRONTEND_DIR.is_dir():
    @app.get("/", include_in_schema=False)
    def landing_redirect():
        return RedirectResponse(url="/landing.html")

    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
else:
    logger.warning("Frontend dir not found at %s - serving API only", FRONTEND_DIR)
