package com.warroomlive.config;

import com.warroomlive.signaling.SignalingHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * Registers the raw WebSocket signaling endpoint at {@code /ws/signal}.
 *
 * <p>Raw text frames (rather than STOMP) keep the negotiation path minimal and
 * low-latency, which matters for real-time WebRTC signaling.
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final SignalingHandler signalingHandler;
    private final String[] allowedOrigins;

    public WebSocketConfig(
            SignalingHandler signalingHandler,
            @Value("${warroomlive.signaling.allowed-origins:*}") String allowedOrigins) {
        this.signalingHandler = signalingHandler;
        this.allowedOrigins = allowedOrigins.split("\\s*,\\s*");
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(signalingHandler, "/ws/signal")
                .setAllowedOriginPatterns(allowedOrigins);
    }
}
