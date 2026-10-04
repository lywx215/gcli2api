"""CLI and Antigravity model routing (no import-time storage or network I/O)."""

CONTRACT_VERSION = "routing-execution-1"


async def prepare_route_context(channel, protocol, requested_model, raw_request):
    """Capture one authoritative route and feature snapshot after the Hi branch.

    Imports are lazy: importing a router never reads storage or credentials.
    Config failures are fail-closed and use the existing safe error boundary.
    Legacy requests still execute the original converter/normalizer chain.
    """
    from config import (
        get_antigravity_stream2nostream,
        get_compatibility_mode_enabled,
        get_return_thoughts_to_frontend,
    )
    from src.router.model_api_errors import (
        ErrorOrigin, ModelApiErrorException, ModelApiProtocol, make_model_api_error,
    )
    from .policy import build_policy_snapshot
    from .projection import project_request
    from .routing import resolve
    from .store import load_channel_routes
    from .types import FeatureSnapshot, ModelRouteContext

    protocol = ModelApiProtocol(protocol)
    try:
        policy = build_policy_snapshot()
        result = await load_channel_routes(channel, policy)
    except Exception:
        raise ModelApiErrorException(
            make_model_api_error(origin=ErrorOrigin.LOCAL, status=503)
        ) from None
    if not result.valid:
        raise ModelApiErrorException(
            make_model_api_error(origin=ErrorOrigin.LOCAL, status=503)
        )
    feature_snapshot = FeatureSnapshot(
        compatibility_mode=await get_compatibility_mode_enabled(),
        return_thoughts=await get_return_thoughts_to_frontend(),
        antigravity_stream2nostream=await get_antigravity_stream2nostream(),
    )
    projection = project_request(channel, protocol, requested_model, raw_request, feature_snapshot)
    resolution = resolve(
        channel, protocol, requested_model, projection, result.compiled, policy, feature_snapshot,
    )
    # For unmatched/empty tables the real master normalizer remains authoritative
    # about acceptance of malformed inputs. Do not replace that path with a guess.
    if resolution.explicit_target and not resolution.accepted:
        if resolution.error is not None:
            raise ModelApiErrorException(resolution.error)
        raise ModelApiErrorException(
            make_model_api_error(origin=ErrorOrigin.LOCAL, status=503)
        )
    return ModelRouteContext(
        channel, protocol, requested_model, projection, feature_snapshot, resolution,
        result.compiled.config_digest, policy.digest,
    )


def normalization_model(route_context):
    """Feed the target family, not its opaque public alias, to legacy converters."""
    return route_context.resolution.features["normalization_model"]


def check_route_dispatch(payload, route_context):
    """Never disguise a wrong-family normalization by overwriting its model."""
    if route_context is not None and route_context.resolution.explicit_target:
        if payload.get("model") != route_context.resolution.dispatch_model:
            from src.router.model_api_errors import (
                ErrorOrigin, ModelApiErrorException, make_model_api_error,
            )
            raise ModelApiErrorException(
                make_model_api_error(origin=ErrorOrigin.LOCAL, status=503)
            )
    return payload


def rewrite_health_identity(payload, *, protocol, requested_model):
    """Hi stays a pure local branch with no policy, config or credential reads."""
    from .public_response import rewrite_success_identity
    return rewrite_success_identity(payload, protocol=protocol, requested_model=requested_model)


async def adapt_model_response(response, *, route_context):
    """One final protocol-specific identity adaptation, after existing parsing."""
    from .public_response import adapt_public_response
    return await adapt_public_response(response, route_context=route_context)


async def prepare_catalog_context(channel):
    """Validate fresh routing before any dynamic catalog/credential acquisition."""
    from config import (
        get_antigravity_stream2nostream, get_compatibility_mode_enabled,
        get_return_thoughts_to_frontend,
    )
    from src.router.model_api_errors import (
        ErrorOrigin, ModelApiErrorException, make_model_api_error,
    )
    from .policy import build_policy_snapshot
    from .store import load_channel_routes
    from .types import FeatureSnapshot

    try:
        policy = build_policy_snapshot()
        result = await load_channel_routes(channel, policy)
    except Exception:
        raise ModelApiErrorException(
            make_model_api_error(origin=ErrorOrigin.LOCAL, status=503)
        ) from None
    if not result.valid:
        raise ModelApiErrorException(
            make_model_api_error(origin=ErrorOrigin.LOCAL, status=503)
        )
    features = FeatureSnapshot(
        compatibility_mode=await get_compatibility_mode_enabled(),
        return_thoughts=await get_return_thoughts_to_frontend(),
        antigravity_stream2nostream=await get_antigravity_stream2nostream(),
    )
    return result.compiled, policy, features
