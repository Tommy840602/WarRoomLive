package com.warroomlive.config;

import com.warroomlive.signaling.SignalingHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Registers the raw WebSocket signaling endpoint at {@code /ws/signal}.
 *
 * <p>Raw text frames (rather than STOMP) keep the negotiation path minimal and
 * low-latency, which matters for real-time WebRTC signaling.
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    /** Session attribute holding the handshake JWT's expiry epoch-millis (oidc mode). */
    public static final String TOKEN_EXPIRY_ATTRIBUTE = "warroomlive.tokenExpiry";

    /** Session attribute holding the handshake JWT's subject (oidc mode). */
    public static final String SUBJECT_ATTRIBUTE = "warroomlive.subject";

    /**
     * Session attribute holding the display name the identity provider vouches
     * for (oidc mode). Its presence is what makes a name trustworthy.
     */
    public static final String VERIFIED_NAME_ATTRIBUTE = "warroomlive.verifiedName";

    private final SignalingHandler signalingHandler;
    private final String[] allowedOrigins;
    private final int maxFrameBytes;

    public WebSocketConfig(
            SignalingHandler signalingHandler,
            @Value("${warroomlive.signaling.allowed-origins:*}") String allowedOrigins,
            @Value("${warroomlive.signaling.max-frame-bytes:65536}") int maxFrameBytes) {
        this.signalingHandler = signalingHandler;
        this.allowedOrigins = allowedOrigins.split("\\s*,\\s*");
        this.maxFrameBytes = maxFrameBytes;
    }

    /**
     * Caps inbound frames at the container, before anything is buffered or
     * parsed — the cheapest place to refuse a payload that has no business
     * being this large. Signaling messages are SDP, ICE candidates and chat;
     * the biggest legitimate one (an SDP offer) is a few kilobytes, so 64 KB is
     * generous. The CRDT plane sets its own, much larger limit, since document
     * updates are a different shape of traffic entirely.
     */
    @Bean
    ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(maxFrameBytes);
        container.setMaxBinaryMessageBufferSize(maxFrameBytes);
        return container;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(signalingHandler, "/ws/signal")
                .addInterceptors(tokenExpiryInterceptor())
                .setAllowedOriginPatterns(allowedOrigins);
    }

    /**
     * Captures what the handshake credential proves, for the handler to enforce
     * later: when the token expires, who presented it, and what name the
     * identity provider vouches for.
     *
     * <p>The identity matters because a WebSocket carries its own claims in
     * every message. Without this, {@code from} and the display name are
     * whatever the client typed — so a logged-in user could still join under
     * anyone's name, and no server-side decision could ever be made about
     * <em>who</em> a peer is, only about which connection it arrived on.
     *
     * <p>A no-op without OIDC (no JWT authentication present), which is what
     * keeps the zero-dependency default working.
     */
    private static HandshakeInterceptor tokenExpiryInterceptor() {
        return new HandshakeInterceptor() {
            @Override
            public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                    WebSocketHandler wsHandler, Map<String, Object> attributes) {
                Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
                if (authentication instanceof JwtAuthenticationToken jwtAuth
                        && jwtAuth.getToken() instanceof Jwt jwt) {
                    if (jwt.getExpiresAt() != null) {
                        attributes.put(TOKEN_EXPIRY_ATTRIBUTE, jwt.getExpiresAt().toEpochMilli());
                    }
                    if (jwt.getSubject() != null) {
                        attributes.put(SUBJECT_ATTRIBUTE, jwt.getSubject());
                    }
                    verifiedNameOf(jwt).ifPresent(name ->
                            attributes.put(VERIFIED_NAME_ATTRIBUTE, name));
                }
                return true;
            }

            @Override
            public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                    WebSocketHandler wsHandler, Exception exception) {
            }
        };
    }

    /**
     * The name to show for an authenticated peer, preferring what a human would
     * recognise. {@code preferred_username} and {@code name} are the standard
     * OIDC claims for it; the subject is the last resort, since it is
     * guaranteed to exist but is often an opaque identifier.
     */
    private static Optional<String> verifiedNameOf(Jwt jwt) {
        for (String claim : List.of("preferred_username", "name", "email")) {
            String value = jwt.getClaimAsString(claim);
            if (value != null && !value.isBlank()) {
                return Optional.of(value.trim());
            }
        }
        return Optional.ofNullable(jwt.getSubject());
    }
}
