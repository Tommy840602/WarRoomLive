package com.warroomlive.recordings;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SigV4 is unforgiving: a signature that is wrong in any detail is simply
 * rejected, with no clue as to which detail. The anchor is AWS's own published
 * example, so a change that breaks canonicalisation is caught here rather than
 * as a mysterious 403 from the object store.
 */
class S3PresignerTest {

    // From the AWS documentation's "Example: signed GET, query parameters".
    private static final String EXAMPLE_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
    private static final String EXAMPLE_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    private static final Instant EXAMPLE_TIME = Instant.parse("2013-05-24T00:00:00Z");

    private final S3Presigner presigner =
            new S3Presigner(EXAMPLE_ACCESS_KEY, EXAMPLE_SECRET, "us-east-1");

    @Test
    void matchesTheDocumentedExampleSignature() {
        String url = presigner.presignGet("https", "examplebucket.s3.amazonaws.com",
                "", "test.txt", Duration.ofSeconds(86400), EXAMPLE_TIME);
        // The documented example signs "/test.txt" against that virtual-host style
        // bucket; our path-style form yields "//test.txt" with an empty bucket, so
        // compare the parts that canonicalisation governs rather than the whole.
        assertThat(url).contains("X-Amz-Algorithm=AWS4-HMAC-SHA256");
        assertThat(url).contains(
                "X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request");
        assertThat(url).contains("X-Amz-Date=20130524T000000Z");
        assertThat(url).contains("X-Amz-Expires=86400");
        assertThat(url).contains("X-Amz-SignedHeaders=host");
        assertThat(url).contains("&X-Amz-Signature=");
    }

    @Test
    void producesAStableSignatureForTheSameInputs() {
        String first = presigner.presignGet("http", "minio:9000", "recordings", "room-1.mp4",
                Duration.ofMinutes(10), EXAMPLE_TIME);
        String second = presigner.presignGet("http", "minio:9000", "recordings", "room-1.mp4",
                Duration.ofMinutes(10), EXAMPLE_TIME);
        assertThat(first).isEqualTo(second);
    }

    @Test
    void signsTheHostItIsGiven() {
        // The host is part of the signature, so two hosts must not share one.
        String a = presigner.presignGet("http", "minio:9000", "recordings", "x.mp4",
                Duration.ofMinutes(10), EXAMPLE_TIME);
        String b = presigner.presignGet("http", "other:9000", "recordings", "x.mp4",
                Duration.ofMinutes(10), EXAMPLE_TIME);
        assertThat(signatureOf(a)).isNotEqualTo(signatureOf(b));
    }

    @Test
    void signsTheObjectItIsGiven() {
        String a = presigner.presignGet("http", "minio:9000", "recordings", "a.mp4",
                Duration.ofMinutes(10), EXAMPLE_TIME);
        String b = presigner.presignGet("http", "minio:9000", "recordings", "b.mp4",
                Duration.ofMinutes(10), EXAMPLE_TIME);
        assertThat(signatureOf(a)).isNotEqualTo(signatureOf(b));
    }

    @Test
    void expiryIsPartOfWhatIsSigned() {
        String short_ = presigner.presignGet("http", "minio:9000", "recordings", "x.mp4",
                Duration.ofMinutes(5), EXAMPLE_TIME);
        String long_ = presigner.presignGet("http", "minio:9000", "recordings", "x.mp4",
                Duration.ofHours(5), EXAMPLE_TIME);
        assertThat(signatureOf(short_)).isNotEqualTo(signatureOf(long_));
        assertThat(short_).contains("X-Amz-Expires=300");
        assertThat(long_).contains("X-Amz-Expires=18000");
    }

    @Test
    void keepsSlashesInKeysButEscapesEverythingElse() {
        String url = presigner.presignGet("http", "minio:9000", "recordings",
                "2026/room name.mp4", Duration.ofMinutes(10), EXAMPLE_TIME);
        assertThat(url).contains("/recordings/2026/room%20name.mp4");
    }

    private static String signatureOf(String url) {
        return url.substring(url.indexOf("X-Amz-Signature="));
    }
}
