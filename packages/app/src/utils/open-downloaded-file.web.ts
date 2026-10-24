/** The browser's own download handling applies on web; nothing to open here. */
export async function openDownloadedFile(_input: {
  uri: string;
  mimeType: string | null;
  dialogTitle: string;
}): Promise<void> {}
