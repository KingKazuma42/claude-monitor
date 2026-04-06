import * as path from 'path';
import { SessionStatus } from '../models/claudeSession';

export interface ActivityRouteCandidate {
  pid: number;
  claudeSessionId?: string;
  transcriptPath?: string;
  workDir: string;
  status: SessionStatus;
}

export interface ActivityRouteInput {
  filePath: string;
  workDir: string;
  sessionId?: string;
}

export function findActivityOwnerPid(
  activity: ActivityRouteInput,
  sessions: ActivityRouteCandidate[],
  sessionIdToPid: Map<string, number>,
  transcriptPathToPid: Map<string, number>,
): number | undefined {
  if (activity.sessionId) {
    const mappedPid = sessionIdToPid.get(activity.sessionId);
    if (mappedPid !== undefined) {
      return mappedPid;
    }

    const sessionMatch = sessions.find(session => session.claudeSessionId === activity.sessionId);
    if (sessionMatch) {
      return sessionMatch.pid;
    }
  }

  const transcriptMatch = transcriptPathToPid.get(activity.filePath);
  if (transcriptMatch !== undefined) {
    return transcriptMatch;
  }

  const fallbackCandidates = sessions.filter(session =>
    session.status !== 'stopped' &&
    !session.claudeSessionId &&
    isExactWorkDirMatch(activity.workDir, session.workDir)
  );

  if (fallbackCandidates.length === 1) {
    return fallbackCandidates[0].pid;
  }

  return undefined;
}

function isExactWorkDirMatch(activityWorkDir: string, sessionWorkDir: string): boolean {
  if (!activityWorkDir || !sessionWorkDir) {
    return false;
  }
  return path.resolve(activityWorkDir) === path.resolve(sessionWorkDir);
}
