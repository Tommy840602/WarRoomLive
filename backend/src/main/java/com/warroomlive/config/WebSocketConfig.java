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

import java.util.Map;

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
     * Long-lived connections must not outlive the credential that opened them:
     * capture the handshake JWT's expiry so the handler can enforce it per
     * message. A no-op without OIDC (no JWT authentication present).
     */
    private static HandshakeInterceptor tokenExpiryInterceptor() {
        return new HandshakeInterceptor() {
            @Override
            public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                    WebSocketHandler wsHandler, Map<String, Object> attributes) {
                Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
                if (authentication instanceof JwtAuthenticationToken jwtAuth
                        && jwtAuth.getToken() instanceof Jwt jwt
                        && jwt.getExpiresAt() != null) {
                    attributes.put(TOKEN_EXPIRY_ATTRIBUTE, jwt.getExpiresAt().toEpochMilli());
                }
                return true;
            }

            @Override
            public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                    WebSocketHandler wsHandler, Exception exception) {
            }
        };
    }
}
