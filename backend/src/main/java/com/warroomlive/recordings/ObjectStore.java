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
 * The little of the object store this application needs beyond presigning:
 * deleting an object when its recording is removed.
 *
 * <p>Deletion is issued as a presigned DELETE the server then follows, reusing
 * the signing that already exists rather than adding a second credential path.
 * The URL is never handed out — it is minted and used in the same call.
 */
@Component
public class ObjectStore {

    private static final Logger log = LoggerFactory.getLogger(ObjectStore.class);

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
        String host = endpoint.replaceFirst("^[a-zA-Z]+://", "");
        String scheme = endpoint.startsWith("https") ? "https" : "http";
        String url = new S3Presigner(accessKey, secretKey, "us-east-1")
                .presign("DELETE", scheme, host, bucket, objectKey, Duration.ofMinutes(1), Instant.now());
        try {
            // URI.create, not uri(String): the string overload is a URI *template*
            // and re-encodes what it is given, turning the credential's %2F into
            // %252F — which the store rejects as a malformed credential. The
            // signature covers the encoded form, so it must be passed through
            // untouched.
            rest.delete().uri(URI.create(url)).retrieve().toBodilessEntity();
            return true;
        } catch (Exception e) {
            log.warn("Could not delete object {}: {}", objectKey, e.getMessage());
            return false;
        }
    }
}
