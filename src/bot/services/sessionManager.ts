interface UserSession {
  state: string;
  data: Record<string, any>;
}

const sessions = new Map<number, UserSession>();

export const getSession = (userId: number): UserSession => {
  if (!sessions.has(userId)) {
    sessions.set(userId, { state: 'IDLE', data: {} });
  }
  return sessions.get(userId)!;
};

export const updateSession = (userId: number, session: Partial<UserSession>) => {
  const current = getSession(userId);
  sessions.set(userId, { ...current, ...session });
};

export const clearSession = (userId: number) => {
  sessions.delete(userId);
};
