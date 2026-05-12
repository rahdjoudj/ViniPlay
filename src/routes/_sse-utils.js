export function sendSseEvent(sseClients, userId, eventName, data) {
  const clients = sseClients.get(userId);
  if (!clients?.length) return;
  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => c.res.write(message));
}

export function broadcastAdminUpdate(sseClients, activeStreamProcesses, activeRedirectStreams) {
  const transcodedLive = Array.from(activeStreamProcesses.values()).map(info => ({
    streamKey: info.streamKey,
    userId: info.userId,
    username: info.username,
    channelName: info.channelName,
    channelLogo: info.channelLogo,
    streamProfileName: info.streamProfileName,
    startTime: info.startTime,
    clientIp: info.clientIp,
    isTranscoded: true,
  }));

  const redirectLive = Array.from(activeRedirectStreams.values()).map(info => ({
    streamKey: `${info.userId}::${info.historyId}`,
    userId: info.userId,
    username: info.username,
    channelName: info.channelName,
    channelLogo: info.channelLogo,
    streamProfileName: info.streamProfileName,
    startTime: info.startTime,
    clientIp: info.clientIp,
    isTranscoded: false,
  }));

  const combinedLive = [...transcodedLive, ...redirectLive];
  for (const clients of sseClients.values()) {
    clients.forEach(c => {
      if (c.isAdmin) {
        c.res.write(`event: activity-update\ndata: ${JSON.stringify({ live: combinedLive })}\n\n`);
      }
    });
  }
}

export function broadcastSseToAll(sseClients, eventName, data) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  let count = 0;
  for (const clients of sseClients.values()) {
    clients.forEach(c => { c.res.write(message); count++; });
  }
  return count;
}
