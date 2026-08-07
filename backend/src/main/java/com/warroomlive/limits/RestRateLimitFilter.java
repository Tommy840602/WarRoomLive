package com.warroomlive.limits;

import io.micrometer.core.instrument.MeterRegistry;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Per-caller rate limit for the HTTP API.
 *
 * <p>The real-time planes were given abuse limits while the REST API kept none,
 * and it is the side with the expensive operations: minting a LiveKit token,
 * signing a playback URL, running a full-text query, starting an egress job. A
 * loop over any of them costs far more server-side than it does to issue.
 *
 * <p>Runs ahead of authentication on purpose — a flood should be refused before
 * it can make the server verify a signature or reach the identity provider's
 * JWKS. That is also why the limit is keyed by address rather than by subject.
 *
 * <p>Health and the auth bootstrap are exempt because probes and page loads hit
 * them constantly, and the LiveKit webhook because it is trusted infrastructure
 * whose messages carry recording completions — dropping one loses a recording,
 * and it already authenticates itself.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 50)
public class RestRateLimitFilter extends OncePerRequestFilter {

    private static final Set<String> EXEMPT =
            Set.of("/api/health", "/api/auth/config", "/api/livekit/webhook");
    /** A caller idle this long is indistinguishable from one never seen. */
    private static final Duration IDLE = Duration.ofMinutes(10);
    /** How often to sweep idle buckets — cheap, and there is no disconnect to hook. */
    private static final int EVICT_EVERY = 1000;

    private final RateLimiter limiter;
    private final MeterRegistry metrics;
    private final AtomicInteger sinceEviction = new AtomicInteger();

    public RestRateLimitFilter(MeterRegistry metrics,
            @Value("${warroomlive.api.max-requests-per-second:20}") int maxRequestsPerSecond) {
        this.limiter = new RateLimiter(maxRequestsPerSecond);
        this.metrics = metrics;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !path.startsWith("/api/") || EXEMPT.contains(path);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        if (sinceEviction.incrementAndGet() >= EVICT_EVERY) {
            sinceEviction.set(0);
            limiter.evictIdle(IDLE);
        }
        if (!limiter.tryConsume(callerOf(request))) {
            metrics.counter("warroomlive.api.rejected", "reason", "rate").increment();
            // 429 rather than a silent drop: unlike a signaling burst, an HTTP
            // caller is waiting for an answer and can back off if told to.
            response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
            response.setHeader("Retry-After", "1");
            return;
        }
        chain.doFilter(request, response);
    }

    /**
     * The client address as the edge saw it.
     *
     * <p>Every request arrives through the frontend's nginx, so the socket's peer
     * is always the proxy — without X-Forwarded-For the whole internet would
     * share one bucket. nginx <em>appends</em> to that header, so the entry it
     * added is the <strong>last</strong> one; earlier entries came from the
     * client and are forgeable. Reading the first would let any caller mint
     * itself a fresh allowance per request.
     */
    static String callerOf(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.substring(forwarded.lastIndexOf(',') + 1).trim();
        }
        String remote = request.getRemoteAddr();
        return remote == null ? "unknown" : remote;
    }
}
