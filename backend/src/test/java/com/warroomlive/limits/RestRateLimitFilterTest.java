package com.warroomlive.limits;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Who a request is charged to, and what happens when a caller outruns its
 * allowance. The address the limit keys on is the whole security of the thing:
 * get it wrong in one direction and every user shares one bucket, wrong in the
 * other and any caller can mint itself a fresh one per request.
 */
class RestRateLimitFilterTest {

    private final RestRateLimitFilter filter =
            new RestRateLimitFilter(new SimpleMeterRegistry(), 10);

    private static MockHttpServletRequest get(String path) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", path);
        request.setRemoteAddr("172.20.0.5");
        return request;
    }

    @Test
    void chargesTheEntryNginxAppendedNotTheOneTheClientSent() {
        // nginx APPENDS the peer it saw, so the trustworthy entry is the last.
        // A client that sends its own X-Forwarded-For only pads the front.
        MockHttpServletRequest request = get("/api/search/messages");
        request.addHeader("X-Forwarded-For", "1.2.3.4, 203.0.113.9");

        assertThat(RestRateLimitFilter.callerOf(request)).isEqualTo("203.0.113.9");
    }

    @Test
    void aForgedHeaderCannotBuyAFreshAllowance() {
        RestRateLimitFilter limited = new RestRateLimitFilter(new SimpleMeterRegistry(), 2);
        for (int i = 0; i < 4; i++) {
            assertThat(run(limited, withForwarded("attacker-" + i, "203.0.113.9")).getStatus())
                    .as("burst message %d", i)
                    .isEqualTo(200);
        }
        // Fifth request, a brand-new forged prefix — still the same real caller.
        assertThat(run(limited, withForwarded("attacker-new", "203.0.113.9")).getStatus())
                .isEqualTo(429);
    }

    @Test
    void fallsBackToTheSocketAddressWithoutAProxy() {
        assertThat(RestRateLimitFilter.callerOf(get("/api/media/token"))).isEqualTo("172.20.0.5");
    }

    @Test
    void refusesExcessWithRetryAfterRatherThanDroppingSilently() {
        MockHttpServletResponse response = null;
        for (int i = 0; i < 25; i++) {
            response = run(filter, get("/api/media/token"));
        }
        assertThat(response.getStatus()).isEqualTo(429);
        assertThat(response.getHeader("Retry-After")).isEqualTo("1");
    }

    @Test
    void separateCallersDoNotShareAnAllowance() {
        RestRateLimitFilter limited = new RestRateLimitFilter(new SimpleMeterRegistry(), 2);
        for (int i = 0; i < 10; i++) {
            run(limited, withForwarded(null, "203.0.113.9"));
        }
        assertThat(run(limited, withForwarded(null, "203.0.113.9")).getStatus()).isEqualTo(429);
        assertThat(run(limited, withForwarded(null, "203.0.113.10")).getStatus()).isEqualTo(200);
    }

    @Test
    void leavesHealthAuthBootstrapAndTheWebhookAlone() {
        // Probes and page loads hit the first two constantly; the webhook carries
        // recording completions and authenticates itself.
        assertThat(filter.shouldNotFilter(get("/api/health"))).isTrue();
        assertThat(filter.shouldNotFilter(get("/api/auth/config"))).isTrue();
        assertThat(filter.shouldNotFilter(get("/api/livekit/webhook"))).isTrue();
        assertThat(filter.shouldNotFilter(get("/actuator/prometheus"))).isTrue();
        assertThat(filter.shouldNotFilter(get("/api/search/messages"))).isFalse();
    }

    private static MockHttpServletRequest withForwarded(String prefix, String real) {
        MockHttpServletRequest request = get("/api/search/messages");
        request.addHeader("X-Forwarded-For", prefix == null ? real : prefix + ", " + real);
        return request;
    }

    private static MockHttpServletResponse run(RestRateLimitFilter filter,
            MockHttpServletRequest request) {
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = new MockFilterChain();
        try {
            filter.doFilter(request, response, chain);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        return response;
    }
}
