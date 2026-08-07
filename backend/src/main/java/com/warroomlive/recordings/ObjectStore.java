package com.warroomlive.recordings;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;

/**
 * The application's one place that knows where the object store is and how to
 * authorise a request to it.
 *
 * <p>Every operation is expressed as a presigned URL, whether it is handed to a
 * browser (playback, download, upload) or followed by this server itself
 * (deleting, checking a size). That keeps a single signing path — one thing to
 * get right — and means the store's credentials never leave this process.
 *
 * <p>The signed host is the store's own, because SigV4 covers it. A browser
 * reaches that host through nginx, which rewrites {@code Host} back to match,
 * so the request that arrives is byte-for-byte the one that was signed.
 */
@Component
public class ObjectStore {

    private static final Logger log = LoggerFactory.getLogger(ObjectStore.class);
    private static final String REGION = "us-east-1";

    private final String endpoint;
    private final String bucket;
    private final String accessKey;
    private final String secretKey;
    private final RestClient rest = RestClient.create();

    public ObjectStore(
            @Value("${warroomlive.media.egress-s3-endpoint:}") String endpoint,
            @Value("${warroomlive.media.egress-s3-bucket:}") String bucket,
            @Value("${warroomlive.media.egress-s3-access-key:}") String accessKey,
            @Value("${warroomlive.media.egress-s3-secret-key:}") String secretKey) {
        this.endpoint = endpoint;
        this.bucket = bucket;
        this.accessKey = accessKey;
        this.secretKey = secretKey;
    }

    public boolean configured() {
        return !endpoint.isBlank() && !bucket.isBlank() && !accessKey.isBlank();
    }

    /** Host of the store as this server and the proxy reach it — this is what gets signed. */
    public String host() {
        String withoutScheme = endpoint.replaceFirst("^[a-zA-Z]+://", "");
        int slash = withoutScheme.indexOf('/');
        return slash < 0 ? withoutScheme : withoutScheme.substring(0, slash);
    }

    /**
     * A presigned URL for one object and one method.
     *
     * @return the absolute URL against the store's own host; callers that hand
     *         it to a browser strip the host and prepend the proxy prefix
     */
    public String presign(String method, String objectKey, Duration ttl) {
        String scheme = endpoint.startsWith("https") ? "https" : "http";
        return new S3Presigner(accessKey, secretKey, REGION)
                .presign(method, scheme, host(), bucket, objectKey, ttl, Instant.now());
    }

    /** The path-and-query of a presigned URL, for serving behind a proxy prefix. */
    public String pathAndQueryOf(String signedUrl) {
        String host = host();
        return signedUrl.substring(signedUrl.indexOf(host) + host.length());
    }

    /**
     * The stored size of an object, or -1 if it is not there.
     *
     * <p>A presigned PUT cannot itself enforce a size limit, so the only honest
     * check is to ask the store what actually landed.
     */
    public long sizeOf(String objectKey) {
        if (!configured()) {
            return -1;
        }
        try {
            var headers = rest.head()
                    .uri(URI.create(presign("HEAD", objectKey, Duration.ofMinutes(1))))
                    .retrieve()
                    .toBodilessEntity()
                    .getHeaders();
            return headers.getContentLength();
        } catch (Exception e) {
            log.debug("Could not stat object {}: {}", objectKey, e.getMessage());
            return -1;
        }
    }

    /**
     * Removes an object.
     *
     * @return true when the object is gone — including when it was already
     *         absent, since the goal is its absence, not the deleting
     */
    public boolean delete(String objectKey) {
        if (!configured()) {
            return false;
        }
        try {
            // URI.create, not uri(String): the string overload is a URI *template*
            // and re-encodes what it is given, turning the credential's %2F into
            // %252F — which the store rejects as a malformed credential. The
            // signature covers the encoded form, so it must be passed through
            // untouched.
            rest.delete()
                    .uri(URI.create(presign("DELETE", objectKey, Duration.ofMinutes(1))))
                    .retrieve()
                    .toBodilessEntity();
            return true;
        } catch (Exception e) {
            log.warn("Could not delete object {}: {}", objectKey, e.getMessage());
            return false;
        }
    }
}
