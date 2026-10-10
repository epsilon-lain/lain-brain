# From a Voice Thinking Space to an Inner-Speech Interface
## Helping AI Follow a User’s Evolving Intent

## TL;DR

I built Lain Brain, an AssemblyAI-powered thinking workspace with editable text and spoken macros. I propose feeding continuous inner-speech transcripts into a background context module so AI can follow a user’s changing intent. The prototype supplies a software starting point; the proposed benefits need controlled testing.

**A research proposal grounded in the Lain Brain prototype**  
Concept and prototype: epsilon-lain, creator of Lain Brain  
Writing and research assistance: AI tools  
October 10, 2026

## Abstract

People often produce associations, tentative explanations, corrections, and changes of intent before submitting a short message to an AI assistant. The final message may omit the context needed to identify what they currently mean. I propose a continuous inner-speech text interface, assuming that an upstream brain–computer interface has already converted inner speech into accurate, ordered text. The system retains the complete incoming text history, continuously derives a representation of the user’s current intent with links to source passages, and uses that context for AI responses and explicitly invoked macros. The AssemblyAI version of Lain Brain supplies concrete software components for streaming transcription, an editable thinking space, context-aware macro interpretation, deliberate submission, and recoverable edits. These components provide an engineering basis for the proposed interface. I outline controlled comparisons to evaluate misunderstanding, correction effort, and macro performance. Continuous inner-speech integration and its interaction benefits remain research objectives.

## 1. The Context Behind a Message

Consider a student looking at a circuit diagram. The student first thinks, “The voltage becomes smaller after connecting the speaker,” then wonders, “Is the internal resistance taking part of the voltage?” and subsequently adds, “I have not confirmed that explanation.” The final message to the AI is simply: “Why does this happen?”

The student knows what “this” refers to. The assistant may infer a different referent or answer a different question because it has received only the final message. The student must then reconstruct the omitted context and correct the assistant.

If the preceding language were available, the assistant would have additional evidence about the phenomenon under discussion, the explanation being considered, and the student’s uncertainty. My research question is whether continuous access to this process language can help an AI follow a user’s latest intent and reduce repeated clarification.

This proposal takes the availability of accurate inner-speech text as its starting assumption. Its focus is the software interaction layer that receives that text.

## 2. An Engineering Starting Point: Lain Brain with AssemblyAI

Lain Brain is an open-source Obsidian prototype developed for a voice-driven thinking workspace. Its public AssemblyAI Voice Agent Hackathon submission describes live transcription into Chat Space, editable text segments, spoken submission through “ka,” and editing macros defined in ordinary language. Ambiguous commands remain available as text.[1]

The inspected source version contains several components relevant to the proposed interface.[2]

| Component | Inspectable implementation | Relevance |
| --- | --- | --- |
| Streaming language input | `AssemblyAIVoiceInput.ts` handles partial and finalized transcripts, with session and turn identifiers | Text can arrive incrementally during an ongoing input session |
| Editable thinking space | `ChatSpace.ts` represents segments with identifiers, source labels, and creation times; supports editing and snapshots | Language fragments become objects the user can inspect and manipulate |
| Input interpretation | `VoiceIntentBuffer.ts` and `VoiceIntentServices.ts` implement cleanup, macro candidate handling, and contextual classification | Content and operational expressions can share a language input channel |
| Macro execution | `MacroExecutor.ts` implements submission, segment editing, and recovery | Language can operate on the current thinking workspace |
| Integration test cases | Repository tests cover input handling, macros, timeouts, duplicate submission, and failure preservation | Components have explicit, inspectable behavioral checks |

These observations come from source inspection and the project’s published description. The demonstration guide specifies a live-input, edit, recover, and submit sequence.[3] This article does not report a new microphone experiment, a rerun of the tests, or a measured improvement in user intent understanding.

The prototype provides a concrete arrangement of continuous language capture, editable text, macro operations, and an AI request. AssemblyAI’s streaming documentation describes provisional transcripts that can be revised and final transcripts that mark completed turns.[4] A transcription turn boundary provides a processing boundary; it does not necessarily establish that the user has finished thinking.

## 3. Extending the Text Interface to Inner Speech

Research has demonstrated real-time decoding of imagined sentences from implanted neural recordings, including the 2025 study by Kunz and colleagues in *Cell*.[5] This supplies background for investigating an inner-speech text channel.

My proposed interface begins when ordered text reaches the application. A BCI supplies the text; a background context module preserves and organizes the process; an AI model uses it to interpret the user’s current message and explicit operational expressions. Grok is a candidate model for evaluating this design.

The architecture has three cooperating parts.

### 3.1 Complete Process History

The system records every incoming text event: associations, tentative explanations, self-corrections, topic changes, and macro expressions. Events retain their original wording, order, time information, and revision relationships. When an upstream transcript is revised, the revision is recorded as another event.

Editing the active workspace also produces an event. A macro that removes a segment from the current view changes that view while preserving the interaction history. The user can therefore revise the expression being prepared without losing the record of how it developed.

A complete persistent process archive is a proposed addition. The current short-lived voice interpretation buffer does not implement it.

### 3.2 Current-Intent Representation

A background module continuously organizes what the user is discussing, the current goal, the referents of ambiguous expressions, recently rejected explanations, and unresolved questions. I use “subconscious module,” inherited from the Lain Brain design, as a name for this background software process.

Each derived interpretation should link back to the source events that support it. This makes it possible to inspect why the system believes the user means something and to revise that interpretation when later text changes the meaning.

The system must distinguish a hypothesis the user considered from a conclusion the user adopted. In the circuit example, “Is internal resistance responsible?” should remain a tentative explanation when followed by “I have not confirmed it.”

Complete history retention does not require feeding the entire archive into every model request. The model can receive recent events, the current-intent representation, and retrieved historical passages. Evaluation must establish whether this organization preserves the details that matter for interpretation.

### 3.3 Responses and Inner-Speech Macros

For a response, the assistant receives the current question, the current-intent representation, and relevant source passages. For an operation, an explicit macro expression maps to a defined action, such as submitting the current text, returning to a previous segment, editing the active workspace, or restoring an edit.

All expressions remain in the process history. Recording an event, producing a response, and executing an operation are separate decisions. This allows continuous context collection while keeping interaction organized around the user’s changing goals.

Under the assumed text input channel, these operations could support communication and workspace control without typing or overt speech.

## 4. The Feasibility Argument

The AssemblyAI prototype supplies an inspectable engineering argument: a system can receive incremental language text, organize it into editable segments, interpret configured operational expressions, and submit the prepared content to an AI. Extending that software boundary to an inner-speech text source builds on existing components.

The next development work concerns complete history retention, continuous current-intent updates, and their integration with the response and macro pathways. A Grok connection also requires implementation; no Grok–Neuralink joint experiment is reported here.

Two hypotheses can guide evaluation:

1. With the same final question, access to the preceding language process reduces mistakes about the user’s referent and current goal.
2. A derived current-intent representation with retrieved source passages preserves useful context within a bounded input budget and supports language-based interaction.

These hypotheses describe effects to measure. Prototype functionality alone does not establish them.

## 5. An Evaluation That Can Start with Spoken Input

An initial software study can use voluntary spoken think-aloud input. Participants express intermediate associations and corrections while performing a task. Spoken think-aloud behavior may differ from spontaneous inner speech, so transfer to actual inner-speech transcripts requires later evaluation.

Compare three conditions using the same model, task materials, and output budget:

| Condition | Context supplied to the assistant | Question tested |
| --- | --- | --- |
| Final message | Task materials and the final user message | Baseline interaction performance |
| Complete process text | The same materials, all process text available up to that moment, and the final message | Whether additional process information improves understanding |
| Intent state plus evidence | The same materials, a derived current-intent representation, relevant original passages, and the final message | Whether background organization preserves useful meaning |

Use counterbalanced task variants and randomized condition order to limit practice and ordering effects. Every condition must use only information available at the response time, without later corrections leaking into earlier answers. Report context length and processing latency as well as task outcomes.

Tasks should include omitted referents, self-correction, changing goals, personal terminology, and mentions of macros that are discussion rather than requests to execute them. Participant-provided goals and corrections should serve as the evaluation reference; the model’s own interpretation cannot define whether it understood correctly.

Useful outcomes include referent identification accuracy, user correction count, task completion time, unsupported intent inferences, macro execution success, and false execution rate. A longitudinal study could additionally test whether the assistant follows a user’s revised meaning instead of continuing to use an older interpretation.

No scores are supplied for experiments that have not been conducted.

## 6. Limitations

This proposal assumes accurate inner-speech text from the upstream BCI. When decoding errors occur, the system should mark the affected segments as uncertain and preserve that uncertainty in downstream intent tracking.

## 7. A Collaboration Opportunity

I invite collaboration at the text interface. BCI teams can supply participant-authorized inner-speech transcripts and revision information. AI teams can investigate streaming context, personalized interpretation, and macro recognition. Human–computer interaction researchers can evaluate understanding and operational effort.

Neuralink’s official speech-restoration research direction makes it a relevant potential contact.[6] Grok is a candidate understanding model, and Lain Brain provides an existing voice-based workspace and macro prototype. This article describes a proposed collaboration; it does not announce an established partnership.

Because a complete inner-speech history is highly personal, users should control when recording begins and ends, which records are supplied to a model, and how their records are deleted. These controls can be incorporated into the macro interface itself.

The intended interaction is straightforward: while a user is still forming an expression, the assistant can use the language context arriving alongside it. When the user expresses an explicit operation through inner speech, the system can connect that expression to the workspace. Lain Brain offers a concrete software starting point for investigating this form of human–AI communication.

## References and Evidence Version

1. [Lain Brain: A Voice-Driven Thinking Space — public project submission](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon/lain-brain/lain-brain-a-voice-driven-thinking-space). Cited as the creator’s published project description, rather than an independent experimental evaluation.
2. [Lain Brain source snapshot](https://github.com/epsilon-lain/lain-brain/tree/0d3bab1cb415285b07dee72603b87f25f9681a81). Inspected files: `AssemblyAIVoiceInput.ts`, `ChatSpace.ts`, `VoiceIntentBuffer.ts`, `VoiceIntentServices.ts`, `MacroExecutor.ts`, and `tests/voice-intent-integration.test.mjs`. Branch: `codex/voice-intent-jev-integration`; commit date: September 29, 2026.
3. [VOICE_DEMO.md — demonstration guide](https://github.com/epsilon-lain/lain-brain/blob/0d3bab1cb415285b07dee72603b87f25f9681a81/VOICE_DEMO.md). Documents macro definition, recovery, and deliberate submission.
4. [AssemblyAI: Turn Detection](https://www.assemblyai.com/docs/streaming/turn-detection). Describes partial and final streaming turns. Current documentation may differ from the model configuration used by the inspected prototype.
5. Kunz, E. M., et al. (2025). *Inner speech in motor cortex and implications for speech neuroprostheses*. **Cell, 188**(17), 4658–4673.e17. [doi:10.1016/j.cell.2025.06.015](https://doi.org/10.1016/j.cell.2025.06.015). [PubMed record](https://pubmed.ncbi.nlm.nih.gov/40816265/). Supports the neural-decoding background, rather than the unmeasured interaction benefits proposed here.
6. [Neuralink: Speech Restoration](https://neuralink.com/trials/speech-restoration/). Identifies a relevant research direction.

Sources were checked on October 10, 2026. This is a research proposal and engineering prototype analysis. A systematic prior-art review and controlled user study remain to be completed.

---

# X Launch Thread — Draft

Publish the four posts below as a thread. Attach the existing demonstration video to the second post and add the public article URL to the fourth. The video caption should identify the features actually shown. Place the article on a publicly accessible page, such as your GitHub, before sharing its public URL.

### 1/4

What if AI could follow the thoughts behind a message? I built Lain Brain with AssemblyAI: a voice thinking space with editable text and spoken macros. I propose extending its text interface to continuous inner-speech transcripts. @neuralink @grok

### 2/4

The starting point is open-source software: streaming speech, editable thought segments, macro handling, and deliberate submission. Full inner-speech history and continuous intent tracking are the next research step. Demo + code: https://github.com/epsilon-lain/lain-brain

### 3/4

Assume a BCI already provides inner-speech text. Preserve the incoming history, track current intent with links to original passages, and support explicit mental macros. Test whether this reduces misunderstandings and corrections compared with final-message-only chat.

### 4/4

I’m looking for BCI and AI researchers to discuss this proposal and test the text-interface layer. It builds on my AssemblyAI Lain Brain prototype. Could continuous inner-speech context help AI follow a user’s changing intent? @neuralink @grok @elonmusk

## Contact and Sharing Notes

- Include an existing demonstration, source code, and a public article link so researchers have something concrete to inspect.
- Potential mentions: [Neuralink](https://x.com/neuralink), [Grok](https://x.com/grok), and [Elon Musk](https://x.com/elonmusk).
- Check the Grok team’s current social links on its [official website](https://x.ai/). At the time of review, that site also linked to [@SpaceXAI](https://x.com/spacexai).
- Ask for feedback on the architecture and evaluation, and for research partners willing to test the text-interface layer. A public post provides a contact opportunity but does not guarantee a response.

**Publication status: Draft. Not posted to X.**
