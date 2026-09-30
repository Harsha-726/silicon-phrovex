/* The service worker owns browser notification clicks. The page still owns
 * scheduling and persistence because task data is authenticated and private. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;
  const target = taskId ? `/?notificationTask=${encodeURIComponent(taskId)}` : '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'silico-notification-click', taskId });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

