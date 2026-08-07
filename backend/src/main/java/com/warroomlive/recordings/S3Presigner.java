package com.warroomlive.recordings;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.TreeMap;

/**
 * Signature Version 4 presigning for object GETs.
 *
 * <p>Playback needs a URL the browser can open, but the object store's
 * credentials must never leave the server. A presigned URL is exactly that
 * trade: it carries a signature that authorises one object, for a short time,
 * and nothing else.
 *
 * <p>Written by hand rather than pulling in the AWS SDK for one operation. The
 * algorithm is fully determined by its inputs, so it is unit-tested against
 * AWS's published example, and the result is also exercised against a real
 * MinIO in the recording stack — a signature that is subtly wrong fails
 * loudly there rather than silently here.
 */
public class S3Presigner {

    private static final DateTimeFormatter AMZ_DATE =
            DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC);
    private static final DateTimeFormatter DATE_STAMP =
            DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneOffset.UTC);

    private final String accessKey;
    private final String secretKey;
    private final String region;

    public S3Presigner(String accessKey, String secretKey, String region) {
        this.accessKey = accessKey;
        this.secretKey = secretKey;
        this.region = region;
    }

    /**
     * Presigns a GET for {@code bucket/key}, path-style.
     *
     * @param host  the host the request will carry — it is signed, so it must be
     *              the host the browser actually sends (a proxy in front must
     *              preserve or rewrite it to match)
     * @param scheme http or https, for the returned URL only; not signed
     */
    public String presignGet(String scheme, String host, String bucket, String key,
            Duration expiry, Instant now) {
        return presign("GET", scheme, host, bucket, key, expiry, now);
    }

    /** As {@link #presignGet}, for any HTTP method — deletion uses the same signing. */
    public String presign(String method, String scheme, String host, String bucket, String key,
            Duration expiry, Instant now) {
        String amzDate = AMZ_DATE.format(now);
        String dateStamp = DATE_STAMP.format(now);
        String scope = dateStamp + "/" + region + "/s3/aws4_request";
        String canonicalUri = "/" + bucket + "/" + encodePath(key);

        Map<String, String> query = new TreeMap<>();
        query.put("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
        query.put("X-Amz-Credential", accessKey + "/" + scope);
        query.put("X-Amz-Date", amzDate);
        query.put("X-Amz-Expires", String.valueOf(expiry.toSeconds()));
        query.put("X-Amz-SignedHeaders", "host");
        String canonicalQuery = canonicalQuery(query);

        String canonicalRequest = String.join("\n",
                method,
                canonicalUri,
                canonicalQuery,
                "host:" + host + "\n",
                "host",
                "UNSIGNED-PAYLOAD");

        String stringToSign = String.join("\n",
                "AWS4-HMAC-SHA256", amzDate, scope, hex(sha256(canonicalRequest)));

        byte[] signingKey = signingKey(dateStamp);
        String signature = hex(hmac(signingKey, stringToSign));

        return scheme + "://" + host + canonicalUri + "?" + canonicalQuery
                + "&X-Amz-Signature=" + signature;
    }

    private byte[] signingKey(String dateStamp) {
        byte[] key = hmac(("AWS4" + secretKey).getBytes(StandardCharsets.UTF_8), dateStamp);
        key = hmac(key, region);
        key = hmac(key, "s3");
        return hmac(key, "aws4_request");
    }

    private static String canonicalQuery(Map<String, String> query) {
        StringBuilder out = new StringBuilder();
        query.forEach((k, v) -> {
            if (out.length() > 0) {
                out.append('&');
            }
            out.append(encode(k)).append('=').append(encode(v));
        });
        return out.toString();
    }

    /** Object keys keep their slashes; every other reserved character is escaped. */
    private static String encodePath(String key) {
        StringBuilder out = new StringBuilder();
        for (String segment : key.split("/", -1)) {
            if (out.length() > 0) {
                out.append('/');
            }
            out.append(encode(segment));
        }
        return out.toString();
    }

    /** RFC 3986 encoding: URLEncoder is form encoding and differs in three places. */
    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8)
                .replace("+", "%20")
                .replace("*", "%2A")
                .replace("%7E", "~");
    }

    private static byte[] hmac(byte[] key, String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException("HMAC-SHA256 unavailable", e);
        }
    }

    private static byte[] sha256(String data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
        }
        return out.toString();
    }
}
