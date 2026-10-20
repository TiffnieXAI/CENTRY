from typing import Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Query, HTTPException, status
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.deps import get_current_user
from app.models.models import User, PlatformType
from app.schemas.oauth import AuthorizeUrlResponse, PlatformConnectionResponse
from app.services import oauth_service

router = APIRouter(prefix="/api/v1/oauth", tags=["Platform OAuth"])


@router.get("/{platform}/authorize", response_model=AuthorizeUrlResponse)
def get_authorize_url(platform: PlatformType, current_user: User = Depends(get_current_user)):
    """
    Called by the frontend (authenticated) when the user taps e.g. "Connect
    Shopee". Returns a URL for the frontend to redirect the browser to -
    this endpoint itself can't redirect the user directly, since the
    Bearer token used to call it has no meaning to Shopee/Lazada/TikTok's
    own login pages.
    """
    url = oauth_service.start_authorization(current_user, platform)
    return AuthorizeUrlResponse(authorize_url=url)


@router.get("/{platform}/callback")
async def oauth_callback(platform: PlatformType,
                          code: str,
                          state: str,
                          shop_id: Optional[str] = Query(None),  # Shopee-specific callback param
                          db: Session = Depends(get_db)):
    """
    NOT authenticated - the platform's OAuth server redirects the user's
    browser here directly, with no way to attach a Bearer token. The `state`
    param (generated in /authorize) is what ties this callback back to the
    user who started the flow - see create_oauth_state_token.

    The seller lands here in *their own* browser tab (Shopee/Lazada/TikTok
    redirected them), so on the way out we bounce them back to the frontend's
    connect page with the result in the query string - connect.html reads
    `connected`/`status`/`detail` and refreshes the button states from
    GET /api/v1/oauth/connections.
    """
    try:
        extra = {}
        if shop_id:
            extra["shop_id"] = shop_id
        await oauth_service.complete_authorization(db, platform, code, state, **extra)
    except ValueError as e:
        # Bad/expired state token, or a token exchange the provider rejected.
        # Send the browser home with the reason rather than a bare JSON error.
        return _back_to_connect(platform, "error", str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Failed to connect: {e}")

    return _back_to_connect(platform, "connected")


def _back_to_connect(platform: PlatformType, result: str, detail: Optional[str] = None) -> RedirectResponse:
    params = {"connected": platform.value, "status": result}
    if detail:
        params["detail"] = detail
    return RedirectResponse(url=f"/connect.html?{urlencode(params)}")


@router.get("/connections", response_model=list[PlatformConnectionResponse])
def list_my_connections(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return oauth_service.list_connections(db, current_user.id)


@router.delete("/connections/{connection_id}", response_model=PlatformConnectionResponse)
def disconnect_platform(connection_id: int,
                         current_user: User = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    return oauth_service.disconnect(db, current_user.id, connection_id)
