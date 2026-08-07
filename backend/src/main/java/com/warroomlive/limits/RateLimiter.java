package com.warroomlive.limits;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Token bucket keyed by caller, shared by the planes that need one.
 *
 * <p>The CRDT plane has carried message-rate, update-size and document-size
 * limits from the start; signaling and the REST API had none, so one client
 * could flood either for a whole room. This closes that asymmetry with the same
 * shape of limit the collab service uses: a bucket that refills at the sustained
 * rate and holds a burst of twice that, so ordinary traffic — a join followed by
 * a flurry of ICE candidates, or a page load that fetches three endpoints at
 * once — is never throttled while a runaway sender is.
 *
 * <p>What a key means is the caller's business: signaling keys by session and
 * releases on disconnect, HTTP keys by client address and has no disconnect to
 * hook, which is why {@link #evictIdle} exists. Either way an entry must
 * eventually go, or a long-lived server accumulates one per caller ever seen.
 */
public class RateLimiter {

    private static final class Bucket {
        double tokens;
        long lastRefillNanos;

        Bucket(double tokens, long now) {
            this.tokens = tokens;
            this.lastRefillNanos = now;
        }
    }

    private final double ratePerSecond;
    private final double burst;
    private final Map<String, Bucket> buckets = new ConcurrentHashMap<>();

    public RateLimiter(int ratePerSecond) {
        this.ratePerSecond = ratePerSecond;
        this.burst = ratePerSecond * 2.0;
    }

    /**
     * Charges one message to the caller.
     *
     * @return true when the message may proceed, false when the caller has
     *         outrun its allowance
     */
    public boolean tryConsume(String key) {
        return tryConsume(key, System.nanoTime());
    }

    /** Testable variant: the caller supplies the clock reading. */
    boolean tryConsume(String key, long nowNanos) {
        Bucket bucket = buckets.computeIfAbsent(key, id -> new Bucket(burst, nowNanos));
        synchronized (bucket) {
            double elapsedSeconds = Math.max(nowNanos - bucket.lastRefillNanos, 0) / 1_000_000_000.0;
            bucket.tokens = Math.min(burst, bucket.tokens + elapsedSeconds * ratePerSecond);
            bucket.lastRefillNanos = nowNanos;
            if (bucket.tokens < 1.0) {
                return false;
            }
            bucket.tokens -= 1.0;
            return true;
        }
    }

    /** Drops a disconnected caller's bucket. */
    public void release(String key) {
        buckets.remove(key);
    }

    /**
     * Drops buckets untouched for longer than {@code idle}.
     *
     * <p>Forgetting a caller is not the same as forgiving it: a bucket idle for
     * longer than it takes to refill completely is indistinguishable from a
     * fresh one, so this reclaims memory without handing anyone an allowance
     * they had not already earned.
     *
     * @return how many were dropped
     */
    public int evictIdle(Duration idle) {
        return evictIdle(idle, System.nanoTime());
    }

    int evictIdle(Duration idle, long nowNanos) {
        long cutoff = nowNanos - idle.toNanos();
        int before = buckets.size();
        buckets.values().removeIf(bucket -> {
            synchronized (bucket) {
                return bucket.lastRefillNanos < cutoff;
            }
        });
        return before - buckets.size();
    }

    public int trackedCallers() {
        return buckets.size();
    }
}
