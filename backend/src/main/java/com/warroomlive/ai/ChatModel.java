package com.warroomlive.ai;

import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * One language model, reached over the OpenAI chat-completions API.
 *
 * <p>That wire format rather than any vendor's SDK, because it is the one every
 * runtime speaks: OpenAI and Azure serve it, and so do Ollama, vLLM, LiteLLM and
 * llama.cpp. An operator points {@code AI_BASE_URL} at whichever they run —
 * including one inside their own network, which for a war room whose transcript
 * is the sensitive part is often the only acceptable answer.
 *
 * <p><strong>Timeouts are the design, not a detail.</strong> This sits behind a
 * live subtitle. A model that answers in twelve seconds has not been slow, it
 * has been useless, and the right outcome is to give up and leave the line
 * untranslated rather than to deliver a subtitle for a sentence the room has
 * long since moved past.
 */
@Component
@Profile("ai")
public class ChatModel {

    private static final Logger log = LoggerFactory.getLogger(ChatModel.class);

    /** Subtitle-speed. Gives up while the answer could still matter. */
    private final RestClient live;
    /**
     * Summary-speed. A different client rather than a parameter because the
     * timeout belongs to the connection factory, and because the two calls have
     * genuinely opposite deadlines: nobody is watching a summary generate, and
     * everybody is watching a subtitle. One shared budget would either cut off
     * summaries or leave a translation thread parked for a minute on a line the
     * room finished discussing long ago.
     */
    private final RestClient batch;
    private final String baseUrl;
    private final String apiKey;
    private final String model;
    /** Reset by the first success, so a model that recovers and dies again says so again. */
    private final AtomicBoolean complained = new AtomicBoolean();

    public ChatModel(
            @Value("${warroomlive.ai.base-url:}") String baseUrl,
            @Value("${warroomlive.ai.api-key:}") String apiKey,
            @Value("${warroomlive.ai.model:gpt-4o-mini}") String model,
            @Value("${warroomlive.ai.timeout-ms:6000}") int timeoutMs,
            @Value("${warroomlive.ai.summary-timeout-ms:60000}") int summaryTimeoutMs) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.apiKey = apiKey;
        this.model = model;
        this.live = client(timeoutMs);
        this.batch = client(summaryTimeoutMs);
    }

    private static RestClient client(int timeoutMs) {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        // Connecting is not generating: a model that cannot even be reached
        // should fail fast regardless of how long its answer is allowed to take.
        factory.setConnectTimeout(Duration.ofMillis(Math.min(timeoutMs, 2000)));
        factory.setReadTimeout(Duration.ofMillis(timeoutMs));
        return RestClient.builder().requestFactory(factory).build();
    }

    public boolean configured() {
        return !baseUrl.isBlank();
    }

    public String model() {
        return model;
    }

    /**
     * One completion, or empty if anything at all went wrong.
     *
     * <p>Every failure is the same failure to the callers — a subtitle with no
     * translation, a summary that did not get made — and neither has a
     * meaningful recovery beyond saying so. So this logs and returns empty
     * rather than throwing a hierarchy nobody would branch on.
     *
     * @param maxTokens a ceiling on the reply, so a model that starts rambling
     *                  costs a bounded amount rather than the whole timeout
     */
    public Optional<String> complete(String system, String user, int maxTokens) {
        return complete(system, user, maxTokens, false);
    }

    /** As {@link #complete}, on the longer budget. For summaries, not subtitles. */
    public Optional<String> completeSlow(String system, String user, int maxTokens) {
        return complete(system, user, maxTokens, true);
    }

    private Optional<String> complete(String system, String user, int maxTokens, boolean slow) {
        if (!configured()) return Optional.empty();
        try {
            RestClient.RequestBodySpec request = (slow ? batch : live).post()
                    // URI.create, not the String overload: that one is a URI
                    // template and would mangle any % in a configured base URL.
                    .uri(URI.create(baseUrl + "/chat/completions"))
                    .contentType(MediaType.APPLICATION_JSON);
            if (!apiKey.isBlank()) {
                request = request.header("Authorization", "Bearer " + apiKey);
            }
            JsonNode reply = request
                    .body(Map.of(
                            "model", model,
                            "max_tokens", maxTokens,
                            // Zero, deliberately: two people watching the same
                            // meeting should not read different subtitles, and a
                            // summary that changes on every regeneration is not a
                            // record of anything.
                            "temperature", 0,
                            "messages", List.of(
                                    Map.of("role", "system", "content", system),
                                    Map.of("role", "user", "content", user))))
                    .retrieve()
                    .body(JsonNode.class);
            String content = reply == null ? null
                    : reply.path("choices").path(0).path("message").path("content").asText(null);
            if (content == null || content.isBlank()) {
                log.warn("Model returned no content");
                return Optional.empty();
            }
            complained.set(false);
            return Optional.of(content.strip());
        } catch (Exception e) {
            // Loud once, quiet after. A dead model in a busy room fails once per
            // utterance, and a warning per utterance buries the one that mattered
            // — but logging them all at debug means an operator sees nothing at all.
            if (complained.compareAndSet(false, true)) {
                log.warn("Model call failed ({}); further failures log at debug", e.toString());
            } else {
                log.debug("Model call failed: {}", e.toString());
            }
            return Optional.empty();
        }
    }
}
