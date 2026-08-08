package com.warroomlive.web;

import com.warroomlive.meetings.MeetingEntity;
import com.warroomlive.meetings.MeetingStore;
import com.warroomlive.transcript.MeetingSummaryEntity;
import com.warroomlive.transcript.Summarizer;
import com.warroomlive.transcript.SummaryStore;
import com.warroomlive.transcript.TranscriptLineEntity;
import com.warroomlive.transcript.TranscriptStore;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The key points of a meeting, made once and then kept.
 *
 * <p>{@code POST} is deliberately not "generate": it is "get me the summary,
 * making it if it does not exist yet". Two people opening the panel at the end
 * of a meeting should not buy two model calls and see two different summaries of
 * the hour they both sat through. Regenerating is possible and explicit
 * ({@code ?regenerate=true}) — a person asking for that has decided the first
 * answer was wrong, which is a different thing from a page loading twice.
 */
@RestController
@RequestMapping("/api/meetings")
public class SummaryController {

    /** A transcript long enough to be worth a model call; see {@link Summarizer#MIN_LINES}. */
    private static final int MAX_LINES = 5000;

    private final ObjectProvider<MeetingStore> meetings;
    private final ObjectProvider<TranscriptStore> transcripts;
    private final ObjectProvider<SummaryStore> summaries;
    private final ObjectProvider<Summarizer> summarizer;

    public SummaryController(ObjectProvider<MeetingStore> meetings,
            ObjectProvider<TranscriptStore> transcripts,
            ObjectProvider<SummaryStore> summaries,
            ObjectProvider<Summarizer> summarizer) {
        this.meetings = meetings;
        this.transcripts = transcripts;
        this.summaries = summaries;
        this.summarizer = summarizer;
    }

    @GetMapping("/{room}/{id}/summary")
    public Map<String, Object> get(@PathVariable String room, @PathVariable long id) {
        return describe(store().find(room, id).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "this meeting has no summary yet")));
    }

    @PostMapping("/{room}/{id}/summary")
    public Map<String, Object> create(@PathVariable String room, @PathVariable long id,
            @RequestParam(defaultValue = "false") boolean regenerate) {
        SummaryStore store = store();
        if (!regenerate) {
            Optional<MeetingSummaryEntity> existing = store.find(room, id);
            if (existing.isPresent()) {
                return describe(existing.get());
            }
        }

        Summarizer model = summarizer.getIfAvailable();
        if (model == null || !model.enabled()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "summaries require a configured language model (ai profile)");
        }
        MeetingEntity meeting = meeting(room, id);
        List<TranscriptLineEntity> lines = transcriptStore().window(
                room, meeting.startedAt(), MeetingController.endOf(meeting), MAX_LINES);

        // 422, not 404 or 500. The request was well formed and the meeting is
        // real — there simply was not enough said in it to summarise, and the
        // caller can tell that apart from "no such meeting" and act on it.
        String summary = model.summarize(lines).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.UNPROCESSABLE_ENTITY, lines.size() < Summarizer.MIN_LINES
                        ? "not enough transcript to summarise (" + lines.size() + " lines)"
                        : "the model did not return a summary"));

        return describe(store.save(id, room, model.model(), summary, lines.size()));
    }

    private MeetingEntity meeting(String room, long id) {
        MeetingStore store = meetings.getIfAvailable();
        if (store == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "meeting summaries require the postgres profile");
        }
        return store.byId(room, id).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "no such meeting"));
    }

    private SummaryStore store() {
        SummaryStore store = summaries.getIfAvailable();
        if (store == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "meeting summaries require the postgres profile");
        }
        return store;
    }

    private TranscriptStore transcriptStore() {
        TranscriptStore store = transcripts.getIfAvailable();
        if (store == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "meeting summaries require the postgres profile");
        }
        return store;
    }

    static Map<String, Object> describe(MeetingSummaryEntity summary) {
        Map<String, Object> out = new HashMap<>();
        out.put("meetingId", summary.getMeetingId());
        out.put("room", summary.getRoom());
        out.put("summaryMd", summary.getSummaryMd());
        out.put("model", summary.getModel());
        out.put("lineCount", summary.getLineCount());
        out.put("generatedAt", summary.getGeneratedAt().toString());
        return out;
    }
}
