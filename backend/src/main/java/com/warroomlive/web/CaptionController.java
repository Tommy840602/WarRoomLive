package com.warroomlive.web;

import com.warroomlive.transcript.Summarizer;
import com.warroomlive.transcript.TranscriptLineEntity;
import com.warroomlive.transcript.TranscriptStore;
import com.warroomlive.transcript.Translator;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The caption plane's bootstrap and its record.
 *
 * <p>{@code /config} exists so the browser never has to guess what it is part
 * of. Whether captions are being <em>kept</em> and whether they are being
 * <em>translated</em> are two independent server-side facts — the first needs a
 * database, the second a language model — and a room that is not recording must
 * say so plainly. Nothing is worse here than a UI that implies a transcript is
 * accumulating when nothing is being written down.
 */
@RestController
@RequestMapping("/api/captions")
public class CaptionController {

    private static final int DEFAULT_LIMIT = 200;
    private static final int MAX_LIMIT = 2000;

    private final ObjectProvider<TranscriptStore> transcripts;
    private final ObjectProvider<Translator> translator;
    private final ObjectProvider<Summarizer> summarizer;

    public CaptionController(ObjectProvider<TranscriptStore> transcripts,
            ObjectProvider<Translator> translator, ObjectProvider<Summarizer> summarizer) {
        this.transcripts = transcripts;
        this.translator = translator;
        this.summarizer = summarizer;
    }

    @GetMapping("/config")
    public Map<String, Object> config() {
        Translator t = translator.getIfAvailable();
        Map<String, Object> out = new HashMap<>();
        // Two independent facts, reported separately rather than collapsed into
        // one "AI on" flag. Recording needs a database and translation needs a
        // model; a deployment can very reasonably have one and not the other,
        // and the UI has different things to say in each case.
        out.put("recording", transcripts.getIfAvailable() != null);
        out.put("translation", t != null && t.enabled());
        Summarizer s = summarizer.getIfAvailable();
        out.put("summary", s != null && s.enabled());
        // The pair this deployment subtitles between. A list rather than two
        // booleans, so adding a third language later is a server change and not
        // a protocol change.
        out.put("languages", List.of(
                Map.of("track", "zh", "label", "中文", "recognition", "cmn-Hant-TW"),
                Map.of("track", "en", "label", "English", "recognition", "en-US")));
        return out;
    }

    /**
     * The tail of a room's transcript.
     *
     * <p>Not host-gated, on the same reasoning as the meeting history: this is
     * what was said out loud to everyone in the room, and the chat history is
     * already replayed to any joiner. Gating this while that is open would be a
     * lock on the quieter door.
     */
    @GetMapping("/{room}")
    public List<Map<String, Object>> tail(@PathVariable String room,
            @RequestParam(defaultValue = "" + DEFAULT_LIMIT) int limit) {
        return store().tail(room, Pages.limit(limit, DEFAULT_LIMIT, MAX_LIMIT)).stream()
                .map(CaptionController::describe)
                .toList();
    }

    private TranscriptStore store() {
        TranscriptStore store = transcripts.getIfAvailable();
        if (store == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "transcripts require the postgres profile");
        }
        return store;
    }

    static Map<String, Object> describe(TranscriptLineEntity line) {
        Map<String, Object> out = new HashMap<>();
        out.put("id", line.getId());
        out.put("speaker", line.getSpeaker());
        out.put("peerId", line.getPeerId());
        out.put("lang", line.getLang());
        out.put("text", line.getText());
        out.put("spokenAt", line.getSpokenAt().toString());
        // Absent rather than null when there is none: "not translated" and
        // "translated to an empty string" are different, and only one of them
        // should make the UI render a second line.
        if (line.getTranslation() != null) {
            out.put("translation", line.getTranslation());
            out.put("translationLang", line.getTranslationLang());
        }
        return out;
    }
}
