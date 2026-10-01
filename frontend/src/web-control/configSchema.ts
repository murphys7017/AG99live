/**
 * Shapes served by the plugin's `control/config/schema` endpoint.
 *
 * The control page must not declare the plugin configuration itself: the
 * backend spec is the single source of truth for fields, bounds, defaults and
 * descriptions, so a new setting only has to be declared once on the server.
 */

export type ConfigFieldKind = "text" | "int" | "float" | "bool" | "model" | "provider";

export type ConfigField = {
  key: string;
  kind: ConfigFieldKind;
  label: string;
  description: string;
  default: string | number | boolean;
  minimum?: number;
  maximum?: number;
  step?: number;
  maxLength?: number;
  required: boolean;
  optionsFrom?: "providers" | "models";
};

export type ConfigSection = {
  key: string;
  label: string;
  description: string;
  fields: ConfigField[];
};

export type ConfigValues = Record<string, Record<string, string | number | boolean>>;

export type ProviderOption = {
  id: string;
  model: string;
  type: string;
};

export type ConfigSchemaResponse = {
  sections: ConfigSection[];
  defaults: ConfigValues;
  providers: ProviderOption[];
};

export type SettingsSaveResponse = {
  ok: boolean;
  settings?: ConfigValues;
  error?: {
    code: string;
    field?: string;
    detail?: string;
  };
};

/** Human-readable copy for the codes the backend can reject a patch with. */
export const CONFIG_ERROR_FALLBACKS: Record<string, string> = {
  settings_patch_must_be_non_empty_object: "没有需要保存的修改。",
  settings_patch_invalid: "提交的修改无法解析。",
  settings_fields_invalid: "存在无法识别的配置分组。",
  settings_field_unsupported: "存在无法识别的配置项。",
  settings_value_invalid: "取值格式不正确。",
  settings_value_required: "这一项不能为空。",
  settings_value_too_long: "内容超出长度上限。",
  settings_value_out_of_range: "取值超出允许范围。",
  settings_provider_unknown: "所选 Provider 在 AstrBot 中已不存在，请重新选择。",
  performance_curve_provider_required: "启用表演曲线后必须选择一个 Provider。",
  plugin_config_persistence_unavailable: "当前无法写入插件配置，请在 AstrBot 中检查插件状态。",
  settings_save_failed: "保存失败，配置已回滚到修改前的状态。",
};

export function writeField(
  values: ConfigValues,
  path: string,
  next: string | number | boolean,
): void {
  const [section, key] = path.split(".");
  if (!section || !key) return;
  const bucket = values[section] ?? (values[section] = {});
  bucket[key] = next;
}
