package com.warroomlive.signaling;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Per-connection token bucket for the signaling plane.
 *
 * <p>The CRDT plane has carried message-rate, update-size and document-size
 * limits from the start; the signaling plane had none, so one client could
 * flood the socket for a whole room. This closes that asymmetry with the same
 * shape of limit the collab service uses: a bucket that refills at the
 * sustained rate and holds a burst of twice that, so ordinary traffic — a join
 * followed by a flurry of ICE candidates — is never throttled while a runaway
 * sender is.
 *
 * <p>Buckets are keyed by session id and must be released on disconnect, or a
 * long-lived server accumulates one entry per connection ever made.
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
     * Charges one message to the connection.
     *
     * @return true when the message may proceed, false when the connection has
     *         outrun its allowance
     */
    public boolean tryConsume(String sessionId) {
        return tryConsume(sessionId, System.nanoTime());
    }

    /** Testable variant: the caller supplies the clock reading. */
    boolean tryConsume(String sessionId, long nowNanos) {
        Bucket bucket = buckets.computeIfAbsent(sessionId, id -> new Bucket(burst, nowNanos));
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

    /** Drops a disconnected connection's bucket. */
    public void release(String sessionId) {
        buckets.remove(sessionId);
    }

    int trackedConnections() {
        return buckets.size();
    }
}
