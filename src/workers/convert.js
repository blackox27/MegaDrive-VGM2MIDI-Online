/* Worker protocol, embedded with the parser by the offline build. */
self.onmessage = async function (event) {
  try {
    const song = await VGMCore.decode(
      event.data.bytes,
      event.data.name,
      event.data.options,
    );
    const buffers = [
      ...new Set(
        (song.pcmSegments || []).map((segment) => segment.data.buffer),
      ),
    ];
    postMessage({ song }, buffers);
  } catch (error) {
    postMessage({ error: error.message || String(error) });
  }
};
