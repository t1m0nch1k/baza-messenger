import { Logger } from './types';
export default function autoDownloadModel(logger?: Logger, autoDownloadModelName?: string, withCuda?: boolean): Promise<"Models already exist. Skipping download." | "Model downloaded and built successfully">;
