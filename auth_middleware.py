"""
Production-grade Azure AD JWT validation middleware for FastAPI.

Validates Bearer tokens issued by Azure AD using RS256 signatures
verified against the Azure AD JWKS endpoint. Caches JWKS keys for
24 hours and refreshes on validation failure (handles key rotation).
"""

import os
import time
import logging
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any

import jwt
import httpx
from jwt import PyJWKClient, PyJWK
from fastapi import Request, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

logger = logging.getLogger("lotus_it")

# ──────────────────────────────────────────────
# Configuration from environment
# ──────────────────────────────────────────────
TENANT_ID = os.getenv("AZURE_TENANT_ID", "465441b6-0e7b-4e7c-aa2f-d1d8da82b212")
CLIENT_ID = os.getenv("AZURE_CLIENT_ID", "e571f9a4-e53c-4976-ac11-7dc31fb9c9f5")
ISSUER_V2 = f"https://login.microsoftonline.com/{TENANT_ID}/v2.0"
ISSUER_V1 = f"https://sts.windows.net/{TENANT_ID}/"
JWKS_URL = f"https://login.microsoftonline.com/{TENANT_ID}/discovery/v2.0/keys"

# Valid audience values — the client_id itself and the API URI
VALID_AUDIENCES = [
    CLIENT_ID,
    f"api://{CLIENT_ID}",
]


# ──────────────────────────────────────────────
# User context returned after successful auth
# ──────────────────────────────────────────────
@dataclass
class UserContext:
    email: str
    name: str
    roles: List[str] = field(default_factory=list)
    oid: str = ""


# ──────────────────────────────────────────────
# JWKS key cache with 24-hour TTL and forced
# refresh on signature verification failure
# ──────────────────────────────────────────────
class CachedJWKSClient:
    """Fetches and caches Azure AD JWKS keys with a configurable TTL."""

    def __init__(self, jwks_url: str, cache_ttl: int = 86400):
        self._jwks_url = jwks_url
        self._cache_ttl = cache_ttl  # seconds (default 24h)
        self._keys: Dict[str, Any] = {}  # kid -> key data
        self._jwks_data: Optional[Dict] = None
        self._last_fetch: float = 0.0

    def _needs_refresh(self) -> bool:
        return (
            not self._jwks_data
            or (time.time() - self._last_fetch) > self._cache_ttl
        )

    async def _fetch_keys(self) -> None:
        """Fetch JWKS from Azure AD and populate the cache."""
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(self._jwks_url)
                response.raise_for_status()
                self._jwks_data = response.json()
                self._keys = {}
                for key_data in self._jwks_data.get("keys", []):
                    kid = key_data.get("kid")
                    if kid:
                        self._keys[kid] = key_data
                self._last_fetch = time.time()
                logger.info(
                    "JWKS cache refreshed, %d keys loaded", len(self._keys)
                )
        except Exception as exc:
            logger.error("Failed to fetch JWKS from %s: %s", self._jwks_url, exc)
            # If we have stale keys, keep using them rather than failing hard
            if not self._keys:
                raise

    async def get_signing_key(self, kid: str, force_refresh: bool = False) -> Any:
        """
        Return the signing key for the given kid.

        On cache miss or forced refresh, re-fetch from Azure AD.
        """
        if force_refresh or self._needs_refresh() or kid not in self._keys:
            await self._fetch_keys()

        key_data = self._keys.get(kid)
        if not key_data:
            # One more attempt after forced refresh
            if not force_refresh:
                return await self.get_signing_key(kid, force_refresh=True)
            logger.warning("Signing key not found for kid=%s", kid)
            raise ValueError(f"Signing key not found for kid={kid}")

        return PyJWK(key_data).key


# Module-level singleton
_jwks_client = CachedJWKSClient(JWKS_URL)


# ──────────────────────────────────────────────
# Token validation
# ──────────────────────────────────────────────
async def _validate_token(token: str) -> UserContext:
    """
    Validate an Azure AD JWT and return a UserContext.

    Steps:
    1. Decode header to get kid
    2. Fetch signing key from cached JWKS
    3. Verify signature (RS256), expiry, nbf, audience, issuer
    4. Extract user claims
    """
    # --- Decode header without verification to get kid ---
    try:
        unverified_header = jwt.get_unverified_header(token)
    except jwt.exceptions.DecodeError as exc:
        logger.warning("Malformed token header: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid token")

    kid = unverified_header.get("kid")
    if not kid:
        logger.warning("Token header missing kid claim")
        raise HTTPException(status_code=401, detail="Invalid token")

    alg = unverified_header.get("alg", "RS256")
    if alg != "RS256":
        logger.warning("Unexpected token algorithm: %s", alg)
        raise HTTPException(status_code=401, detail="Invalid token")

    # --- Fetch the signing key ---
    try:
        signing_key = await _jwks_client.get_signing_key(kid)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid token")
    except Exception as exc:
        logger.error("JWKS key retrieval failed: %s", exc)
        raise HTTPException(status_code=401, detail="Authentication service unavailable")

    # --- Verify and decode token ---
    try:
        payload = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=VALID_AUDIENCES,
            issuer=[ISSUER_V2, ISSUER_V1],
            options={
                "verify_exp": True,
                "verify_nbf": True,
                "verify_aud": True,
                "verify_iss": True,
                "require": ["exp", "iss", "aud"],
            },
        )
    except jwt.ExpiredSignatureError:
        logger.info("Token expired")
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidAudienceError:
        logger.warning("Token audience mismatch")
        raise HTTPException(status_code=401, detail="Invalid token")
    except jwt.InvalidIssuerError:
        logger.warning("Token issuer mismatch")
        raise HTTPException(status_code=401, detail="Invalid token")
    except jwt.InvalidSignatureError:
        # Signature failed — try once more with a forced JWKS refresh
        # in case Azure AD rotated keys
        logger.info("Signature verification failed, forcing JWKS refresh")
        try:
            signing_key = await _jwks_client.get_signing_key(kid, force_refresh=True)
            payload = jwt.decode(
                token,
                signing_key,
                algorithms=["RS256"],
                audience=VALID_AUDIENCES,
                issuer=[ISSUER_V2, ISSUER_V1],
                options={
                    "verify_exp": True,
                    "verify_nbf": True,
                    "verify_aud": True,
                    "verify_iss": True,
                    "require": ["exp", "iss", "aud"],
                },
            )
        except Exception as retry_exc:
            logger.warning("Token validation failed after JWKS refresh: %s", retry_exc)
            raise HTTPException(status_code=401, detail="Invalid token")
    except jwt.PyJWTError as exc:
        logger.warning("Token validation error: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid token")

    # --- Extract user claims ---
    email = (
        payload.get("preferred_username")
        or payload.get("email")
        or payload.get("upn")
        or ""
    )
    name = payload.get("name", "")
    roles = payload.get("roles", [])
    oid = payload.get("oid", "")

    if not email:
        logger.warning("Token missing email claim, oid=%s", oid)
        raise HTTPException(status_code=401, detail="Invalid token: missing identity")

    return UserContext(email=email, name=name, roles=roles, oid=oid)


# ──────────────────────────────────────────────
# FastAPI dependencies
# ──────────────────────────────────────────────
_bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
) -> UserContext:
    """
    FastAPI dependency that extracts and validates the Azure AD Bearer token.

    Raises 401 if:
    - Authorization header is missing or empty
    - Token is missing the Bearer prefix (handled by HTTPBearer)
    - Token is expired, malformed, or has an invalid signature
    - Token audience or issuer doesn't match
    """
    if credentials is None:
        logger.info("Missing or malformed Authorization header")
        raise HTTPException(
            status_code=401,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials
    if not token:
        logger.info("Empty Bearer token")
        raise HTTPException(
            status_code=401,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return await _validate_token(token)


async def require_admin(
    user: UserContext = Depends(get_current_user),
) -> UserContext:
    """
    FastAPI dependency that verifies the user has the IT.Admin role.

    Raises 403 if the role is missing.
    """
    if "IT.Admin" not in user.roles:
        logger.warning(
            "Admin access denied for user=%s oid=%s roles=%s",
            user.email,
            user.oid,
            user.roles,
        )
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    return user
