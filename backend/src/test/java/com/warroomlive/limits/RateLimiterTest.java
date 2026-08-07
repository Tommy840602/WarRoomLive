package com.warroomlive.limits;

import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The limiter decides whether real users get throttled, so the behaviour that
 * matters is as much about what it *allows* as what it stops. Time is injected
 * rather than slept through.
 */
class RateLimiterTest {

    private static final long SECOND = 1_000_000_000L;

    @Test
    void allowsAnOpeningBurstOfTwiceTheRate() {
        RateLimiter limiter = new RateLimiter(60);
        // A join immediately followed by a flurry of ICE candidates is normal.
        for (int i = 0; i < 120; i++) {
            assertThat(limiter.tryConsume("s", 0L)).as("message %d", i).isTrue();
        }
        assertThat(limiter.tryConsume("s", 0L)).isFalse();
    }

    @Test
    void refillsAtTheConfiguredRate() {
        RateLimiter limiter = new RateLimiter(60);
        for (int i = 0; i < 120; i++) {
            limiter.tryConsume("s", 0L);
        }
        assertThat(limiter.tryConsume("s", 0L)).isFalse();

        // Half a second later, 30 more are available — and no more.
        long half = SECOND / 2;
        for (int i = 0; i < 30; i++) {
            assertThat(limiter.tryConsume("s", half)).as("refilled message %d", i).isTrue();
        }
        assertThat(limiter.tryConsume("s", half)).isFalse();
    }

    @Test
    void sustainedTrafficAtTheLimitIsNeverThrottled() {
        RateLimiter limiter = new RateLimiter(60);
        // One message every 1/60s for a simulated minute.
        for (int i = 0; i < 3600; i++) {
            long now = i * (SECOND / 60);
            assertThat(limiter.tryConsume("s", now)).as("steady message %d", i).isTrue();
        }
    }

    @Test
    void doesNotAccumulateCreditWhileIdle() {
        RateLimiter limiter = new RateLimiter(60);
        // An hour of silence still only buys the burst allowance, not an hour's worth.
        long later = 3600 * SECOND;
        for (int i = 0; i < 120; i++) {
            assertThat(limiter.tryConsume("s", later)).isTrue();
        }
        assertThat(limiter.tryConsume("s", later)).isFalse();
    }

    @Test
    void limitsEachConnectionSeparately() {
        RateLimiter limiter = new RateLimiter(60);
        for (int i = 0; i < 120; i++) {
            limiter.tryConsume("noisy", 0L);
        }
        assertThat(limiter.tryConsume("noisy", 0L)).as("the flooding connection").isFalse();
        assertThat(limiter.tryConsume("quiet", 0L)).as("an innocent bystander").isTrue();
    }

    @Test
    void releasesBucketsSoLongRunningServersDoNotLeak() {
        RateLimiter limiter = new RateLimiter(60);
        limiter.tryConsume("a", 0L);
        limiter.tryConsume("b", 0L);
        assertThat(limiter.trackedCallers()).isEqualTo(2);

        limiter.release("a");
        assertThat(limiter.trackedCallers()).isEqualTo(1);
    }

    @Test
    void evictsIdleBucketsForCallersThatNeverDisconnect() {
        // HTTP has no close event to release on, so idle callers are swept.
        RateLimiter limiter = new RateLimiter(60);
        limiter.tryConsume("gone", 0L);
        limiter.tryConsume("still-here", 9 * SECOND);

        assertThat(limiter.evictIdle(Duration.ofSeconds(5), 10 * SECOND)).isEqualTo(1);
        assertThat(limiter.trackedCallers()).isEqualTo(1);
    }

    @Test
    void evictionForgetsACallerWithoutForgivingOne() {
        // A bucket idle past a full refill is indistinguishable from a fresh
        // one, so dropping it cannot hand anyone an allowance they had not
        // already earned back by waiting.
        RateLimiter limiter = new RateLimiter(60);
        for (int i = 0; i < 120; i++) {
            limiter.tryConsume("flooder", 0L);
        }
        assertThat(limiter.tryConsume("flooder", 0L)).isFalse();

        // Idle long enough to refill completely, then evicted.
        limiter.evictIdle(Duration.ofSeconds(5), 10 * SECOND);
        assertThat(limiter.trackedCallers()).isZero();

        // Still throttled the moment it floods again, from the same full bucket
        // it would have had anyway.
        for (int i = 0; i < 120; i++) {
            limiter.tryConsume("flooder", 10 * SECOND);
        }
        assertThat(limiter.tryConsume("flooder", 10 * SECOND)).isFalse();
    }
}
