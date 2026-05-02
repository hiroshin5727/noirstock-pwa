self.addEventListener('message', (event) => {
  const { id, type } = event.data || {};
  if (type === 'ping') self.postMessage({ id, ok: true, message: 'ocrWorker ready' });
});
