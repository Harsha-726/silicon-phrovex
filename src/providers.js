// Future integration contracts. Providers return normalized domain objects and
// never write directly to tasks; the application command pipeline owns writes.
export class CalendarProvider {
  async listEvents(_range) { throw new Error('Calendar provider not configured'); }
}

export class LMSProvider {
  async listAssignments(_range) { throw new Error('LMS provider not configured'); }
}

export class TranscriptionProvider {
  async transcribe(_audio) { throw new Error('Transcription provider not configured'); }
}
