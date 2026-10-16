import { startApi } from "./start";

/**
 * `@bunbooru/api` — the REST API composition root. Boots the server (see
 * {@link startApi}), and re-exports the wire types the web app's Eden client is
 * typed against.
 */
await startApi();

export type {
  ApiKeyDto,
  App,
  AssetDto,
  PageDto,
  SetupCheck as SetupCheckDto,
  TagAliasDto,
  TagDto,
  TagImplicationDto,
  TagVersionDto,
  UploadLimitsDto,
  UserDto,
} from "./server";
export type {
  RuntimeSection as RuntimeSectionDto,
  RuntimeSetting as RuntimeSettingDto,
  SettingSource,
} from "./lib/runtime-config";
export type { ExtensionInfo as ExtensionDto } from "./plugins/host";
