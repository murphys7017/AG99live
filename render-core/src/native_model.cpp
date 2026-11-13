#include <windows.h>
#include <mmsystem.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <random>
#include <string>
#include <string_view>
#include <typeinfo>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "ag99/native/native_model.hpp"
#include "ag99/native/json_utils.hpp"
#include "ag99/native/motion_compiler.hpp"
#include "ag99/native/motion_scheduler.hpp"
#include "ag99/native/settings_controller.hpp"
#include "ag99/live2d/d3d11_renderer.hpp"
#include "ag99/live2d/log.hpp"
#include <CubismFramework.hpp>
#include <CubismModelSettingJson.hpp>
#include <Effect/CubismBreath.hpp>
#include <Effect/CubismEyeBlink.hpp>
#include <Id/CubismIdManager.hpp>
#include <Model/CubismUserModel.hpp>
#include <Motion/ACubismMotion.hpp>
#include <Motion/CubismMotion.hpp>
#include <Motion/CubismExpressionMotionManager.hpp>
#include <Physics/CubismPhysicsJson.hpp>

namespace ag99::native {
using namespace Live2D::Cubism::Framework;
using namespace ag99::native::motion;
class NativeCubismModel final : public CubismUserModel {
public:
  explicit NativeCubismModel(const NativeModelServices& services)
      : services_(services) {}
public:
  ~NativeCubismModel() override {
    if (_eye_blink) {
      CubismEyeBlink::Delete(_eye_blink);
    }
    if (_breath) {
      CubismBreath::Delete(_breath);
    }
    for (auto& [group, motions] : _motion_groups) {
      for (auto* motion : motions) {
        ACubismMotion::Delete(motion);
      }
    }
    for (auto* expression : _expressions) {
      ACubismMotion::Delete(expression);
    }
  }

  bool LoadConfiguredEffects(
      const std::filesystem::path& model_directory,
      CubismModelSettingJson* setting) {
    if (!setting) {
      return false;
    }

    bool loaded_any = false;
    const auto load_effect = [&](const char* file_name,
                                 const char* label,
                                 const auto& loader) {
      if (!file_name || file_name[0] == '\0') {
        return false;
      }
      const auto relative_path = services_.path_from_utf8(file_name);
      if (!relative_path) {
        return false;
      }
      std::vector<csmByte> bytes;
      const auto path = model_directory / *relative_path;
      if (!services_.read_file(path, bytes)) {
        std::cerr << "[cubism] failed to read " << label
                  << ": " << services_.path_to_utf8(path) << '\n';
        return false;
      }
      loader(bytes);
      return true;
    };

    loaded_any = load_effect(
        setting->GetPhysicsFileName(),
        "physics",
        [this](const std::vector<csmByte>& bytes) {
          LoadPhysics(
              bytes.data(), static_cast<csmSizeInt>(bytes.size()));
          ConfigurePhysicsResponse(bytes);
        }) || loaded_any;
    loaded_any = load_effect(
        setting->GetPoseFileName(),
        "pose",
        [this](const std::vector<csmByte>& bytes) {
          LoadPose(
              bytes.data(), static_cast<csmSizeInt>(bytes.size()));
        }) || loaded_any;

    for (csmInt32 index = 0;
         index < setting->GetExpressionCount();
         ++index) {
      const char* name = setting->GetExpressionName(index);
      const char* file_name = setting->GetExpressionFileName(index);
      if (!name || !file_name || file_name[0] == '\0') {
        continue;
      }
      const auto relative_path = services_.path_from_utf8(file_name);
      if (!relative_path) {
        continue;
      }
      std::vector<csmByte> bytes;
      const auto path = model_directory / *relative_path;
      if (!services_.read_file(path, bytes)) {
        std::cerr << "[cubism] failed to read expression "
                  << name << ": " << services_.path_to_utf8(path) << '\n';
        continue;
      }
      if (auto* expression = LoadExpression(
              bytes.data(), static_cast<csmSizeInt>(bytes.size()), name)) {
        _expression_names.emplace_back(name);
        _expression_by_name.emplace(name, expression);
        _expressions.push_back(expression);
        loaded_any = true;
      }
    }
    return loaded_any;
  }

  bool StartExpressionById(const std::string& expression_id) {
    if (!_expressionManager || expression_id.empty()) {
      return false;
    }
    const auto it = _expression_by_name.find(expression_id);
    if (it == _expression_by_name.end() || !it->second) {
      return false;
    }
    return _expressionManager->StartMotion(it->second, false)
        != InvalidMotionQueueEntryHandleValue;
  }

  void ConfigurePhysicsResponse(const std::vector<csmByte>& bytes) {
    if (bytes.empty() || !_model) {
      return;
    }
    CubismPhysicsJson physics_json(
        bytes.data(), static_cast<csmSizeInt>(bytes.size()));
    _physics_input_parameter_ids.clear();
    _physics_output_parameter_ids.clear();
    for (csmInt32 setting_index = 0;
         setting_index < physics_json.GetSubRigCount();
         ++setting_index) {
      for (csmInt32 input_index = 0;
           input_index < physics_json.GetInputCount(setting_index);
           ++input_index) {
        const auto id = physics_json.GetInputSourceId(
            setting_index, input_index);
        if (id) {
          _physics_input_parameter_ids.insert(id->GetString().GetRawString());
        }
      }
      for (csmInt32 output_index = 0;
           output_index < physics_json.GetOutputCount(setting_index);
           ++output_index) {
        const auto id = physics_json.GetOutputsDestinationId(
            setting_index, output_index);
        if (id) {
          _physics_output_parameter_ids.insert(id->GetString().GetRawString());
        }
      }
    }
    RefreshPhysicsResponseParameterIndices();
  }

  void SetPhysicsResponseProtectedParameterIds(
      const std::unordered_set<std::string>& parameter_ids) {
    _physics_response_protected_parameter_ids = parameter_ids;
    RefreshPhysicsResponseParameterIndices();
  }

  void SetPhysicsResponseScale(float scale) {
    if (std::isfinite(scale) && scale > 0.0f) {
      _physics_response_scale = scale;
    }
  }

  void SetAmbientMotionEnabled(bool enabled) {
    _ambient_motion_enabled.store(enabled, std::memory_order_relaxed);
  }

  bool LoadDemoMotions(
      const std::filesystem::path& model_directory,
      CubismModelSettingJson* setting) {
    if (!setting) {
      return false;
    }
    _eye_blink = CubismEyeBlink::Create(setting);
    _breath = CubismBreath::Create();
    if (_breath) {
      csmVector<CubismBreath::BreathParameterData> breath_parameters;
      auto* ids = CubismFramework::GetIdManager();
      if (ids) {
        breath_parameters.PushBack(CubismBreath::BreathParameterData(
            ids->GetId("ParamAngleX"), 0.0f, 15.0f, 6.5345f, 0.5f));
        breath_parameters.PushBack(CubismBreath::BreathParameterData(
            ids->GetId("ParamAngleY"), 0.0f, 8.0f, 3.5345f, 0.5f));
        breath_parameters.PushBack(CubismBreath::BreathParameterData(
            ids->GetId("ParamAngleZ"), 0.0f, 10.0f, 5.5345f, 0.5f));
        breath_parameters.PushBack(CubismBreath::BreathParameterData(
            ids->GetId("ParamBodyAngleX"), 0.0f, 4.0f, 15.5345f, 0.5f));
        breath_parameters.PushBack(CubismBreath::BreathParameterData(
            ids->GetId("ParamBreath"), 0.5f, 0.5f, 3.2345f, 1.0f));
      }
      _breath->SetParameters(breath_parameters);
    }
    csmVector<CubismIdHandle> eye_blink_ids;
    for (csmInt32 index = 0;
         index < setting->GetEyeBlinkParameterCount();
         ++index) {
      eye_blink_ids.PushBack(setting->GetEyeBlinkParameterId(index));
    }
    csmVector<CubismIdHandle> lip_sync_ids;
    for (csmInt32 index = 0;
         index < setting->GetLipSyncParameterCount();
         ++index) {
      lip_sync_ids.PushBack(setting->GetLipSyncParameterId(index));
    }
    _lip_sync_parameter_indices.clear();
    for (csmInt32 index = 0; index < lip_sync_ids.GetSize(); ++index) {
      const auto parameter_index = _model->GetParameterIndex(lip_sync_ids.At(index));
      if (parameter_index >= 0) {
        _lip_sync_parameter_indices.push_back(parameter_index);
      }
    }
    for (csmInt32 group_index = 0;
         group_index < setting->GetMotionGroupCount();
         ++group_index) {
      const char* group = setting->GetMotionGroupName(group_index);
      if (!group) {
        continue;
      }
      auto& motions = _motion_groups[group];
      for (csmInt32 index = 0;
           index < setting->GetMotionCount(group);
           ++index) {
        if (auto* motion = LoadDemoMotion(
                model_directory, setting, group, index, group)) {
          static_cast<CubismMotion*>(motion)->SetEffectIds(
              eye_blink_ids, lip_sync_ids);
          motions.push_back(motion);
        }
      }
    }
    if (_motion_groups["Idle"].empty()) {
      std::cerr << "[cubism] no Idle group motions were available\n";
    }
    return !_motion_groups["Idle"].empty();
  }

  const std::vector<csmInt32>& LipSyncParameterIndices() const noexcept {
    return _lip_sync_parameter_indices;
  }

  void ApplyDrag(float drag_x, float drag_y) {
    AddNormalizedParameterValue("ParamAngleX", drag_x);
    AddNormalizedParameterValue("ParamAngleY", drag_y);
    AddNormalizedParameterValue("ParamAngleZ", drag_x * drag_y * -1.0f);
    AddNormalizedParameterValue("ParamBodyAngleX", drag_x);
    AddNormalizedParameterValue("ParamEyeBallX", drag_x);
    AddNormalizedParameterValue("ParamEyeBallY", drag_y);
  }

  void UpdateMotion(csmFloat32 delta_seconds) {
    if (!_motionManager || !_model) {
      return;
    }

    _model->LoadParameters();
    bool motion_updated = false;
    if (_motionManager->IsFinished()
        && _ambient_motion_enabled.load(std::memory_order_relaxed)) {
      const auto idle = _motion_groups.find("Idle");
      if (idle != _motion_groups.end() && !idle->second.empty()) {
        std::uniform_int_distribution<std::size_t> choose_idle(
            0, idle->second.size() - 1);
        _motionManager->StartMotionPriority(
            idle->second[choose_idle(_motion_random)], false, 1);
      }
    } else {
      motion_updated = _motionManager->UpdateMotion(_model, delta_seconds);
    }
    _model->SaveParameters();
    if (_eye_blink && !motion_updated) {
      _eye_blink->UpdateParameters(_model, delta_seconds);
    }
    if (_expressionManager) {
      _expressionManager->UpdateMotion(_model, delta_seconds);
    }
    if (_breath) {
      _breath->UpdateParameters(_model, delta_seconds);
    }
  }

  void UpdatePhysicsAndPose(csmFloat32 delta_seconds) {
    if (!_model) {
      return;
    }
    if (_physics) {
      const bool scale_response = CapturePhysicsResponseBaseline();
      _physics->Evaluate(_model, delta_seconds);
      if (scale_response) {
        ApplyPhysicsResponseScale();
      }
    }
    if (_pose) {
      _pose->UpdateParameters(_model, delta_seconds);
    }
  }

private:
  void RefreshPhysicsResponseParameterIndices() {
    _physics_response_parameter_indices.clear();
    _physics_response_baseline_values.clear();
    if (!_model) {
      return;
    }
    for (const auto& parameter_id : _physics_output_parameter_ids) {
      if (_physics_input_parameter_ids.contains(parameter_id)
          || _physics_response_protected_parameter_ids.contains(parameter_id)) {
        continue;
      }
      const auto parameter_index = _model->GetParameterIndex(
          CubismFramework::GetIdManager()->GetId(parameter_id.c_str()));
      if (parameter_index >= 0) {
        _physics_response_parameter_indices.push_back(parameter_index);
        _physics_response_baseline_values.push_back(0.0f);
      }
    }
  }

  bool CapturePhysicsResponseBaseline() {
    if (_physics_response_scale == 1.0f
        || _physics_response_parameter_indices.empty()) {
      return false;
    }
    for (std::size_t index = 0;
         index < _physics_response_parameter_indices.size();
         ++index) {
      _physics_response_baseline_values[index] =
          _model->GetParameterValue(_physics_response_parameter_indices[index]);
    }
    return true;
  }

  void ApplyPhysicsResponseScale() {
    for (std::size_t index = 0;
         index < _physics_response_parameter_indices.size();
         ++index) {
      const auto parameter_index = _physics_response_parameter_indices[index];
      const auto before = _physics_response_baseline_values[index];
      const auto after = _model->GetParameterValue(parameter_index);
      const auto minimum = _model->GetParameterMinimumValue(parameter_index);
      const auto maximum = _model->GetParameterMaximumValue(parameter_index);
      _model->SetParameterValue(
          parameter_index,
          std::clamp(
              before + (after - before) * _physics_response_scale,
              minimum,
              maximum));
    }
  }

  void AddNormalizedParameterValue(
      const char* parameter_id,
      float normalized_value) {
    if (!_model || !parameter_id || !std::isfinite(normalized_value)) {
      return;
    }
    const auto parameter_index = _model->GetParameterIndex(
        CubismFramework::GetIdManager()->GetId(parameter_id));
    if (parameter_index < 0) {
      return;
    }
    const auto clamped = std::clamp(normalized_value, -1.0f, 1.0f);
    const auto minimum = _model->GetParameterMinimumValue(parameter_index);
    const auto default_value = _model->GetParameterDefaultValue(parameter_index);
    const auto maximum = _model->GetParameterMaximumValue(parameter_index);
    const auto delta = clamped >= 0.0f
        ? (maximum - default_value) * clamped
        : (default_value - minimum) * clamped;
    _model->SetParameterValue(parameter_index, default_value + delta);
  }

  ACubismMotion* LoadDemoMotion(
      const std::filesystem::path& model_directory,
      CubismModelSettingJson* setting,
      const csmChar* group,
      csmInt32 index,
      const char* label) {
    if (!setting || setting->GetMotionCount(group) <= index) {
      return nullptr;
    }

    const char* file_name = setting->GetMotionFileName(group, index);
    if (!file_name || file_name[0] == '\0') {
      return nullptr;
    }
    const auto relative_path = services_.path_from_utf8(file_name);
    if (!relative_path) {
      return nullptr;
    }
    const auto motion_path = model_directory / *relative_path;
    std::vector<csmByte> motion_bytes;
    if (!services_.read_file(motion_path, motion_bytes)) {
      std::cerr << "[cubism] failed to read " << label
                << " motion: " << services_.path_to_utf8(motion_path) << '\n';
      return nullptr;
    }
    return LoadMotion(
        motion_bytes.data(),
        static_cast<csmSizeInt>(motion_bytes.size()),
        nullptr,
        nullptr,
        nullptr,
        setting,
        group,
        index);
  }

  const NativeModelServices& services_;

  std::unordered_map<std::string, std::vector<ACubismMotion*>> _motion_groups;
  std::mt19937 _motion_random{std::random_device{}()};
  std::vector<ACubismMotion*> _expressions;
  std::vector<std::string> _expression_names;
  std::unordered_map<std::string, ACubismMotion*> _expression_by_name;
  std::vector<csmInt32> _lip_sync_parameter_indices;
  std::unordered_set<std::string> _physics_input_parameter_ids;
  std::unordered_set<std::string> _physics_output_parameter_ids;
  std::unordered_set<std::string> _physics_response_protected_parameter_ids;
  std::vector<csmInt32> _physics_response_parameter_indices;
  std::vector<csmFloat32> _physics_response_baseline_values;
  csmFloat32 _physics_response_scale = 1.0f;
  std::atomic<bool> _ambient_motion_enabled{true};
  CubismEyeBlink* _eye_blink = nullptr;
  CubismBreath* _breath = nullptr;
};


struct NativeModel::Impl {
public:
  explicit Impl(NativeModelServices services)
      : services_(std::move(services)) {}

  ~Impl() {
    _renderer.Shutdown();
    if (_model) {
      delete _model;
      _model = nullptr;
    }
    delete _setting;
    _setting = nullptr;

  }

  bool Load(
      const std::filesystem::path& model_json,
      UINT width,
      UINT height,
      ID3D11Device* device,
      ID3D11DeviceContext* context) {
    _width = width;
    _height = height;
    std::vector<csmByte> setting_bytes;
    if (!services_.read_file(model_json, setting_bytes)) {
      std::cerr << "Failed to read model setting: "
                << services_.path_to_utf8(model_json) << '\n';
      return false;
    }

    _setting = new CubismModelSettingJson(
        setting_bytes.data(), static_cast<csmSizeInt>(setting_bytes.size()));
    const std::filesystem::path model_dir = model_json.parent_path();

    const char* model_file_name = _setting->GetModelFileName();
    std::optional<std::filesystem::path> relative_moc_path;
    if (model_file_name) {
      relative_moc_path = services_.path_from_utf8(model_file_name);
    }
    if (!relative_moc_path) {
      std::cerr << "Model setting has an invalid UTF-8 moc path\n";
      return false;
    }
    const std::filesystem::path moc_path = model_dir / *relative_moc_path;
    std::vector<csmByte> moc_bytes;
    if (!services_.read_file(moc_path, moc_bytes)) {
      std::cerr << "Failed to read model moc: " << services_.path_to_utf8(moc_path) << '\n';
      return false;
    }

    _model = new NativeCubismModel(services_);
    _model->LoadModel(
        moc_bytes.data(), static_cast<csmSizeInt>(moc_bytes.size()));
    if (!_model->GetModel()) {
      std::cerr << "Cubism model creation failed\n";
      return false;
    }
    CacheParameterIds();
    _model->LoadConfiguredEffects(model_dir, _setting);

    if (!_renderer.Initialize(
            *_model, *_setting, device, context, model_dir,
            width, height)) {
      return false;
    }

    csmMap<csmString, csmFloat32> layout;
    _setting->GetLayoutMap(layout);
    _model->GetModelMatrix()->SetupFromLayout(layout);
    if (_width < _height && _model->GetModel()->GetCanvasWidth() > 1.0f) {
      // Match the Native SDK's portrait-window layout correction once.
      _model->GetModelMatrix()->SetWidth(2.0f);
    }

    if (!_model->LoadDemoMotions(model_dir, _setting)) {
      std::cerr << "[cubism] demo motion groups are unavailable; "
                   "rendering will continue without motion playback\n";
    }
    _model_view_base_scale_x = _model->GetModelMatrix()->GetScaleX();
    _model_view_base_scale_y = _model->GetModelMatrix()->GetScaleY();
    _model_view_base_translate_x =
        _model->GetModelMatrix()->GetTranslateX();
    _model_view_base_translate_y =
        _model->GetModelMatrix()->GetTranslateY();
    ApplyModelViewSettings();
    _model->SetAmbientMotionEnabled(
        _settings.Snapshot().ambient_motion_enabled);

    std::cout << "Loaded Live2D model: " << services_.path_to_utf8(model_json) << '\n';
    return true;
  }

  void UpdateAndDraw() {
    if (!_model || !_model->GetModel()) {
      return;
    }

    ApplyPendingModelViewSettings();

    CubismModel* cubism_model = _model->GetModel();
    const auto now = services_.now_seconds();
    const auto delta_seconds = _last_update_seconds > 0.0
        ? static_cast<csmFloat32>(std::clamp(
              now - _last_update_seconds, 0.0, 0.1))
        : 1.0f / 60.0f;
    _last_update_seconds = now;
    _model->UpdateMotion(delta_seconds);
    ApplyPreActionMotion(now);
    ApplyQueuedMotion(now);
    _model->ApplyDrag(services_.drag_x->load(), services_.drag_y->load());
      services_.audio.update_audio_level(delta_seconds, now);
    ApplyParameterFrame(
        services_.audio.speech_lip_sync_intensity(),
        services_.audio.audio_end_seconds() > now,
        delta_seconds,
        now);
    _model->UpdatePhysicsAndPose(delta_seconds);
    cubism_model->Update();

    _renderer.Draw();
  }

  void Resize(UINT width, UINT height) {
    std::scoped_lock lock(_motion_mutex);
    if (width == 0 || height == 0 || !_model) {
      return;
    }
    _width = width;
    _height = height;
    _renderer.Resize(width, height);
  }

  void SetModelSync(const ag99::runtime::Json& payload) {
    std::scoped_lock lock(_motion_mutex);
    const auto* previous_profile = SelectedModelProfile(_model_sync_payload);
    const auto* next_profile = SelectedModelProfile(payload);
    const bool selected_runtime_changed =
        SelectedModelName(_model_sync_payload) != SelectedModelName(payload)
        || (previous_profile == nullptr) != (next_profile == nullptr)
        || (previous_profile && next_profile
            && *previous_profile != *next_profile);
    _model_sync_payload = payload;
    if (selected_runtime_changed) {
      _interaction_sway.reset();
      _interaction_gaze.reset();
      _pending_thinking_turn_id.reset();
      _gaze_candidate_valid = false;
      _gaze_candidate_since_ms = 0.0;
    }
    std::unordered_set<std::string> protected_parameter_ids;
    const auto model_info = payload.find("model_info");
    if (model_info != payload.end() && model_info->is_object()) {
      const auto models = model_info->find("models");
      const auto selected_model = json::ReadString(*model_info, "selected_model");
      if (models != model_info->end() && models->is_array()) {
        for (const auto& model : *models) {
          if (!model.is_object()
              || (!selected_model.empty()
                  && json::ReadString(model, "name") != selected_model)) {
            continue;
          }
          const auto profile = model.find("semantic_axis_profile");
          if (profile == model.end() || !profile->is_object()) {
            continue;
          }
          const auto axes = profile->find("axes");
          if (axes == profile->end() || !axes->is_array()) {
            continue;
          }
          for (const auto& axis : *axes) {
            if (!axis.is_object()) {
              continue;
            }
            const auto bindings = axis.find("parameter_bindings");
            if (bindings == axis.end() || !bindings->is_array()) {
              continue;
            }
            for (const auto& binding : *bindings) {
              if (!binding.is_object()) {
                continue;
              }
              const auto parameter_id = binding.find("parameter_id");
              if (parameter_id != binding.end()
                  && parameter_id->is_string()
                  && !parameter_id->get<std::string>().empty()) {
                protected_parameter_ids.insert(
                    parameter_id->get<std::string>());
              }
            }
          }
        }
      }
    }
    _pending_physics_response_protected_parameter_ids =
        std::move(protected_parameter_ids);
    std::cerr << "[motion] model sync received\n";
  }

  ag99::runtime::DesktopSettingsResult HandleDesktopSettingsQuery(
      const ag99::runtime::DesktopSettingsQuery& query) {
    std::scoped_lock lock(_motion_mutex);
    const auto before = _settings.Snapshot();
    auto result = _settings.HandleQuery(query);
    if (query.action == "set" && result.entry) {
      const auto& after = _settings.Snapshot();
      if (std::abs(before.physics_response_scale
                   - after.physics_response_scale) > 1e-9) {
        _pending_physics_response_scale = after.physics_response_scale;
      }
      if (std::abs(before.model_view_scale - after.model_view_scale) > 1e-9
          || std::abs(before.model_view_offset_x - after.model_view_offset_x)
              > 1e-9
          || std::abs(before.model_view_offset_y - after.model_view_offset_y)
              > 1e-9) {
        _pending_model_view_settings = true;
      }
      if (before.ambient_motion_enabled != after.ambient_motion_enabled
          && _model) {
        _model->SetAmbientMotionEnabled(after.ambient_motion_enabled);
      }
      if (std::abs(before.speech_volume - after.speech_volume) > 1e-9
          && services_.audio.set_speech_volume) {
        services_.audio.set_speech_volume(
            static_cast<float>(after.speech_volume));
      }
    }
    return result;
  }

  void QueueOutputSegment(
      ag99::runtime::OutputSegment segment,
      std::optional<NativeSegmentClock> clock = std::nullopt) {
    std::scoped_lock lock(_motion_mutex);
    if (!clock) {
      clock = NativeSegmentClock{
          .turn_id = segment.envelope.turn_id.value_or(""),
          .message_id = segment.envelope.message_id,
          .sequence = segment.sequence,
          .started_at_seconds = services_.now_seconds(),
          .generation = _connection_generation};
    }
    if (clock && clock->generation != 0
        && clock->generation != _connection_generation) {
      return;
    }
    if (segment.motion.state != ag99::runtime::MotionSlot::State::Present) {
      return;
    }
    if (!_model || !_model->GetModel()) {
      QueueMotionTerminalLocked(
          *clock, false, "native_model_unavailable");
      return;
    }
    InterruptMotionPlansLocked("motion_plan_replaced");
    const auto& payload = segment.motion.payload;
    const auto schema = json::ReadString(payload, "schema_version");
    if (schema == std::string(ag99::runtime::kParameterPlanSchema)) {
      _pending_parameter_plan = std::move(segment);
      _pending_parameter_clock = std::move(clock);
      std::cerr << "[motion] parameter plan queued\n";
      return;
    }
    _motion_scheduler.pending_motion_segment = std::move(segment);
    _motion_scheduler.pending_motion_clock = std::move(clock);
    std::cerr << "[motion] intent queued\n";
  }

  bool StartPreAction(const ag99::runtime::PreActionEvent& event) {
    if (event.action != "ready" || !event.envelope.turn_id.has_value()
        || event.request_id.empty() || event.motion.is_null()) {
      return false;
    }
    std::scoped_lock lock(_motion_mutex);
    if (!_model || !_model->GetModel()
        || _motion_scheduler.active_motion
        || _motion_scheduler.pending_motion_segment
        || _active_parameter_plan || _pending_parameter_plan) {
      return false;
    }
    ag99::runtime::OutputSegment segment;
    segment.envelope.turn_id = event.envelope.turn_id;
    segment.envelope.message_id = event.request_id;
    segment.motion.state = ag99::runtime::MotionSlot::State::Present;
    segment.motion.message_type = "engine.motion_intent";
    segment.motion.payload = event.motion;
    NativeSegmentClock clock{
        .turn_id = *event.envelope.turn_id,
        .message_id = event.request_id,
        .sequence = 0,
        .started_at_seconds = services_.now_seconds(),
        .generation = _connection_generation};
    const auto plan = CompileMotionPlan(segment, clock);
    if (!plan) {
      return false;
    }
    _pre_action_motion = *plan;
    std::cerr << "[motion] pre-action started\n";
    return true;
  }

  void CancelPreAction(
      const std::string& turn_id,
      const std::string& request_id = {}) {
    std::scoped_lock lock(_motion_mutex);
    if (!_pre_action_motion
        || (!turn_id.empty() && _pre_action_motion->clock.turn_id != turn_id)
        || (!request_id.empty()
            && _pre_action_motion->clock.message_id != request_id)) {
      return;
    }
    _pre_action_motion.reset();
  }

  std::vector<NativeSegmentTerminal> TakeMotionTerminals() {
    std::scoped_lock lock(_motion_mutex);
    std::vector<NativeSegmentTerminal> terminals;
    terminals.reserve(_motion_scheduler.segment_terminals.size());
    for (auto& terminal : _motion_scheduler.segment_terminals) {
      terminals.push_back(std::move(terminal));
    }
    _motion_scheduler.segment_terminals.clear();
    return terminals;
  }

  void CancelTurn(const std::string& turn_id) {
    std::scoped_lock lock(_motion_mutex);
    if (_motion_scheduler.pending_motion_clock
        && _motion_scheduler.pending_motion_clock->turn_id == turn_id) {
      _motion_scheduler.pending_motion_segment.reset();
      _motion_scheduler.pending_motion_clock.reset();
    }
    if (_motion_scheduler.active_motion
        && _motion_scheduler.active_motion->clock.turn_id == turn_id) {
      _motion_scheduler.active_motion.reset();
    }
    if (_pending_parameter_clock
        && _pending_parameter_clock->turn_id == turn_id) {
      _pending_parameter_plan.reset();
      _pending_parameter_clock.reset();
    }
    if (_active_parameter_plan
        && _active_parameter_plan->clock.turn_id == turn_id) {
      _active_parameter_plan.reset();
    }
  }

  void ResetRuntimeSegments(std::uint64_t generation) {
    std::scoped_lock lock(_motion_mutex);
    _connection_generation = generation;
    _motion_scheduler.pending_motion_segment.reset();
    _motion_scheduler.pending_motion_clock.reset();
    _motion_scheduler.active_motion.reset();
    _pending_parameter_plan.reset();
    _pending_parameter_clock.reset();
    _active_parameter_plan.reset();
    _motion_scheduler.segment_terminals.clear();
  }

  void StartThinkingSway(const std::string& turn_id) {
    if (turn_id.empty()) {
      return;
    }
    std::scoped_lock lock(_motion_mutex);
    _pending_thinking_turn_id = turn_id;
  }

  void ReleaseThinkingSway(const std::string& turn_id) {
    std::scoped_lock lock(_motion_mutex);
    if (_interaction_sway
        && (turn_id.empty() || _interaction_sway->turn_id == turn_id)) {
      ReleaseThinkingSwayLocked(turn_id);
    }
    if (_pending_thinking_turn_id
        && (turn_id.empty() || *_pending_thinking_turn_id == turn_id)) {
      _pending_thinking_turn_id.reset();
    }
  }

  void UpdateCursorGaze(
      HWND window) {
    const auto& settings = _settings.Snapshot();
    if (!settings.cursor_gaze_enabled) {
      std::scoped_lock lock(_motion_mutex);
      _interaction_gaze.reset();
      _gaze_candidate_valid = false;
      return;
    }
    if (!window || !IsWindowVisible(window)) {
      return;
    }
    const double now_ms = services_.now_seconds() * 1000.0;
    if (now_ms < _next_cursor_poll_ms) {
      return;
    }
    _next_cursor_poll_ms = now_ms + settings.cursor_gaze_poll_interval_ms;

    POINT cursor{};
    RECT bounds{};
    if (!GetCursorPos(&cursor) || !GetWindowRect(window, &bounds)) {
      return;
    }
    const double window_width = std::max<LONG>(1, bounds.right - bounds.left);
    const double window_center_x = bounds.left + window_width * 0.5;

    const double target_ratio = Clamp(
        (cursor.x - window_center_x) / std::max(1.0, window_width * 1.5),
        -1.0,
        1.0);
    std::scoped_lock lock(_motion_mutex);
    const bool moved = !_gaze_candidate_valid
        || std::hypot(cursor.x - _gaze_candidate_x,
                      cursor.y - _gaze_candidate_y)
            > settings.cursor_gaze_stationary_distance_px;
    if (moved) {
      _gaze_candidate_valid = true;
      _gaze_candidate_x = cursor.x;
      _gaze_candidate_y = cursor.y;
      _gaze_candidate_since_ms = now_ms;
      if (_interaction_gaze) {
        _interaction_gaze->target_ratio = 0.0;
      }
      return;
    }

    _gaze_candidate_x = cursor.x;
    _gaze_candidate_y = cursor.y;
    if (now_ms - _gaze_candidate_since_ms < settings.cursor_gaze_dwell_ms) {
      return;
    }
    if (!_interaction_gaze) {
      auto state = CreateInteractionGaze(target_ratio);
      if (state) {
        _interaction_gaze = std::move(*state);
        std::cerr << "[interaction] cursor gaze started\n";
      }
      return;
    }
    _interaction_gaze->target_ratio = target_ratio;
  }

private:
  void ApplyModelViewSettings() {
    if (!_model || !_model->GetModelMatrix()) {
      return;
    }
    auto* matrix = _model->GetModelMatrix();
    matrix->Scale(
        _model_view_base_scale_x * static_cast<csmFloat32>(
            _settings.Snapshot().model_view_scale),
        _model_view_base_scale_y * static_cast<csmFloat32>(
            _settings.Snapshot().model_view_scale));
    matrix->Translate(
        _model_view_base_translate_x
            + static_cast<csmFloat32>(
                _settings.Snapshot().model_view_offset_x),
        _model_view_base_translate_y
            + static_cast<csmFloat32>(
                _settings.Snapshot().model_view_offset_y));
  }

  void ApplyPendingModelViewSettings() {
    std::scoped_lock lock(_motion_mutex);
    if (!_pending_model_view_settings) {
      return;
    }
    ApplyModelViewSettings();
    _pending_model_view_settings = false;
  }

  void QueueMotionTerminalLocked(
      const NativeSegmentClock& clock,
      bool success,
      std::string reason = {}) {
    if (clock.turn_id.empty() || clock.message_id.empty()) {
      return;
    }
    _motion_scheduler.segment_terminals.push_back(NativeSegmentTerminal{
        clock, success, std::move(reason)});
  }

  void InterruptMotionPlansLocked(const std::string& reason) {
    if (_motion_scheduler.pending_motion_clock) {
      QueueMotionTerminalLocked(
          *_motion_scheduler.pending_motion_clock, false, reason);
    }
    if (_motion_scheduler.active_motion) {
      QueueMotionTerminalLocked(
          _motion_scheduler.active_motion->clock, false, reason);
    }
    if (_pending_parameter_clock) {
      QueueMotionTerminalLocked(*_pending_parameter_clock, false, reason);
    }
    if (_active_parameter_plan) {
      QueueMotionTerminalLocked(
          _active_parameter_plan->clock, false, reason);
    }
    _motion_scheduler.pending_motion_segment.reset();
    _motion_scheduler.pending_motion_clock.reset();
    _motion_scheduler.active_motion.reset();
    _pending_parameter_plan.reset();
    _pending_parameter_clock.reset();
    _active_parameter_plan.reset();
    _pre_action_motion.reset();
  }

  enum class ParameterContributionOwner {
    InteractionSway,
    InteractionGaze,
    DirectPlan,
    LipSync,
  };

  struct ParameterFrameContribution {
    std::string_view parameter_id;
    csmInt32 parameter_index = -1;
    ParameterContributionOwner owner = ParameterContributionOwner::DirectPlan;
    std::string_view source;
    float value = 0.0f;
    float weight = 1.0f;
    int priority = 0;
    ParameterPresentationState* presentation = nullptr;
    bool presentation_is_direct_plan = false;
    double elapsed_ms = 0.0;
  };

  struct ParameterFrameSnapshot {
    std::string_view parameter_id;
    float base_value = 0.0f;
    float minimum_value = 0.0f;
    float maximum_value = 0.0f;
  };

  struct ParameterFrameGroup {
    csmInt32 parameter_index = -1;
    std::string_view parameter_id;
    std::vector<ParameterFrameContribution*> contributions;
    ParameterFrameSnapshot snapshot;
  };

  static double Clamp(double value, double minimum, double maximum) {
    return std::max(minimum, std::min(maximum, value));
  }

  static float Smoothstep(float value) {
    const auto clamped = std::clamp(value, 0.0f, 1.0f);
    return clamped * clamped * (3.0f - 2.0f * clamped);
  }

  void CacheParameterIds() {
    _parameter_ids.clear();
    auto* model = _model ? _model->GetModel() : nullptr;
    if (!model) {
      return;
    }
    _parameter_ids.resize(static_cast<std::size_t>(model->GetParameterCount()));
    for (csmInt32 index = 0; index < model->GetParameterCount(); ++index) {
      const auto parameter_id = model->GetParameterId(
          static_cast<csmUint32>(index));
      if (parameter_id) {
        _parameter_ids[static_cast<std::size_t>(index)] =
            parameter_id->GetString().GetRawString();
      }
    }
  }

  std::string_view ParameterIdAt(csmInt32 parameter_index) const {
    if (parameter_index < 0
        || static_cast<std::size_t>(parameter_index) >= _parameter_ids.size()) {
      return {};
    }
    return _parameter_ids[static_cast<std::size_t>(parameter_index)];
  }

  std::optional<ParameterPlan> ParseParameterPlan(
      const ag99::runtime::OutputSegment& segment,
      const NativeSegmentClock& clock) const {
    const auto* profile = SelectedModelProfile();
    auto* model = _model ? _model->GetModel() : nullptr;
    if (!profile || !model) {
      return std::nullopt;
    }
    const motion::ParameterPlanContext context{
        profile,
        [model](std::string_view parameter_id)
            -> std::optional<motion::ParameterBindingContext> {
          const auto id = CubismFramework::GetIdManager()->GetId(
              std::string(parameter_id).c_str());
          const auto index = model->GetParameterIndex(id);
          if (index < 0) {
            return std::nullopt;
          }
          return motion::ParameterBindingContext{
              static_cast<std::int32_t>(index),
              model->GetParameterMinimumValue(index),
              model->GetParameterMaximumValue(index),
              model->GetParameterValue(index)};
        }};
    return motion::ParseParameterPlan(segment, clock, context);
  }

  static float ResolveEnvelopeTarget(
      const ParameterPresentationState& presentation,
      float frame_target,
      double elapsed_ms,
      const ParameterPlan* plan) {
    if (!plan) {
      return frame_target;
    }
    const auto elapsed = std::max(0.0, elapsed_ms);
    if (plan->blend_in_ms > 0 && elapsed < plan->blend_in_ms) {
      const auto progress = static_cast<float>(elapsed / plan->blend_in_ms);
      if (plan->curve_preset == "slow_build_quick_release") {
        return presentation.initial_value
            + (frame_target - presentation.initial_value) * progress * progress;
      }
      if (plan->curve_preset == "pulse_settle") {
        const auto x = progress - 1.0f;
        const auto eased = 1.0f + 2.70158f * x * x * x + 1.70158f * x * x;
        return presentation.initial_value
            + (frame_target - presentation.initial_value)
                * std::min(1.08f, eased);
      }
    }
    if (elapsed < plan->blend_in_ms + plan->hold_ms
        && (plan->curve_preset == "breathing_swell"
            || plan->curve_preset == "pulse_settle")) {
      const auto progress = plan->hold_ms > 0
          ? static_cast<float>((elapsed - plan->blend_in_ms) / plan->hold_ms)
          : 1.0f;
      return presentation.neutral_value
          + (frame_target - presentation.neutral_value)
              * (1.0f - 0.06f * std::sin(3.14159265358979323846f * progress));
    }
    return frame_target;
  }

  void ReleaseThinkingSwayLocked(const std::string& turn_id) {
    if (_interaction_sway
        && (turn_id.empty() || _interaction_sway->turn_id == turn_id)
        && !_interaction_sway->release_started_at_ms) {
      _interaction_sway->release_started_at_ms = _interaction_sway->elapsed_ms;
    }
    if (_pending_thinking_turn_id
        && (turn_id.empty() || *_pending_thinking_turn_id == turn_id)) {
      _pending_thinking_turn_id.reset();
    }
  }

  void CollectInteractionContributions(
      float delta_seconds,
      std::vector<ParameterFrameContribution>& contributions) {
    const auto delta_ms = std::max(0.0f, delta_seconds) * 1000.0;
    if (_pending_thinking_turn_id) {
      const auto turn_id = *_pending_thinking_turn_id;
      _pending_thinking_turn_id.reset();
      auto state = CreateInteractionSway(turn_id);
      if (state) {
        _interaction_sway = std::move(*state);
        std::cerr << "[interaction] thinking sway started for turn "
                  << turn_id << '\n';
      } else {
        _interaction_sway.reset();
        std::cerr << "[interaction] no usable lateral semantic axis\n";
      }
    }

    if (_interaction_sway) {
      auto& sway = *_interaction_sway;
      sway.elapsed_ms += delta_ms;
      const auto release_elapsed_ms = sway.release_started_at_ms
          ? sway.elapsed_ms - *sway.release_started_at_ms
          : -1.0;
      if (release_elapsed_ms >= 0.0
          && (sway.release_ms <= 0.0 || release_elapsed_ms >= sway.release_ms)) {
        _interaction_sway.reset();
      } else {
        const auto attack_weight = sway.attack_ms <= 0.0
            ? 1.0f
            : Smoothstep(static_cast<float>(sway.elapsed_ms / sway.attack_ms));
        const auto release_weight = release_elapsed_ms < 0.0 || sway.release_ms <= 0.0
            ? 1.0f
            : Smoothstep(static_cast<float>(
                  1.0 - std::max(0.0, release_elapsed_ms) / sway.release_ms));
        const double phase = std::fmod(sway.elapsed_ms, sway.cycle_ms)
            / sway.cycle_ms;
        const float lateral_offset = static_cast<float>(
            std::sin(phase * 2.0 * 3.14159265358979323846));
        for (auto& binding : sway.bindings) {
          const float target = lateral_offset >= 0.0f
              ? binding.neutral_value
                  + (binding.positive_value - binding.neutral_value) * lateral_offset
              : binding.neutral_value
                  + (binding.negative_value - binding.neutral_value) * -lateral_offset;
          contributions.push_back(ParameterFrameContribution{
              binding.parameter_id,
              binding.parameter_index,
              ParameterContributionOwner::InteractionSway,
              binding.axis_id,
              target,
              binding.weight * attack_weight * release_weight,
              50,
              &binding.presentation,
              false,
              sway.elapsed_ms});
        }
      }
    }

    if (_interaction_gaze) {
      auto& gaze = *_interaction_gaze;
      gaze.elapsed_ms += delta_ms;
      const auto ratio = static_cast<float>(
          std::clamp(gaze.target_ratio, -1.0, 1.0));
      for (auto& binding : gaze.bindings) {
        const float target = ratio >= 0.0f
            ? binding.neutral_value
                + (binding.positive_value - binding.neutral_value) * ratio
            : binding.neutral_value
                + (binding.negative_value - binding.neutral_value) * -ratio;
        contributions.push_back(ParameterFrameContribution{
            binding.parameter_id,
            binding.parameter_index,
            ParameterContributionOwner::InteractionGaze,
            binding.axis_id,
            target,
            binding.weight,
            60,
            &binding.presentation,
            false,
            gaze.elapsed_ms});
      }
    }
  }

  bool ApplyParameterFrame(
      float lip_sync_intensity,
      bool lip_sync_active,
      float delta_seconds,
      double now) {
    std::scoped_lock lock(_motion_mutex);
    if (!_model || !_model->GetModel()) {
      return false;
    }
    if (_pending_physics_response_protected_parameter_ids) {
      _model->SetPhysicsResponseProtectedParameterIds(
          *_pending_physics_response_protected_parameter_ids);
      _pending_physics_response_protected_parameter_ids.reset();
    }
    if (_pending_physics_response_scale) {
      _model->SetPhysicsResponseScale(
          static_cast<csmFloat32>(*_pending_physics_response_scale));
      _pending_physics_response_scale.reset();
    }
    if (!_pending_parameter_plan
        && !_active_parameter_plan
        && !_pending_thinking_turn_id
        && !_interaction_sway
        && !_interaction_gaze
        && !lip_sync_active) {
      return true;
    }
    _frame_contributions.clear();
    if (_pending_parameter_plan) {
      const auto clock = _pending_parameter_clock.value_or(
          NativeSegmentClock{
              .turn_id = _pending_parameter_plan->envelope.turn_id.value_or(""),
              .message_id = _pending_parameter_plan->envelope.message_id,
              .sequence = _pending_parameter_plan->sequence,
              .started_at_seconds = now,
              .generation = _connection_generation});
      const auto parsed = ParseParameterPlan(
          *_pending_parameter_plan, clock);
      const auto turn_id =
          _pending_parameter_plan->envelope.turn_id.value_or("");
      _pending_parameter_plan.reset();
      _pending_parameter_clock.reset();
      if (parsed) {
        if (!parsed->expression_id.empty()
            && !_model->StartExpressionById(parsed->expression_id)) {
          std::cerr << "[motion] expression resource not found: "
                    << parsed->expression_id << '\n';
          QueueMotionTerminalLocked(
              parsed->clock,
              false,
              "expression_resource_not_found:" + parsed->expression_id);
        } else {
          _active_parameter_plan = *parsed;
          ReleaseThinkingSwayLocked(turn_id);
          std::cerr << "[motion] activated parameter plan with "
                    << _active_parameter_plan->bindings.size()
                    << " bindings for "
                    << _active_parameter_plan->duration_ms << " ms\n";
        }
      } else {
        std::cerr << "[motion] parameter plan rejected\n";
        QueueMotionTerminalLocked(
            clock, false, "parameter_plan_rejected");
      }
    }
    const auto fail_active_parameter_plan = [this](std::string reason) {
      if (_active_parameter_plan) {
        QueueMotionTerminalLocked(
            _active_parameter_plan->clock, false, std::move(reason));
        _active_parameter_plan.reset();
      }
    };
    auto* cubism_model = _model->GetModel();
    CollectInteractionContributions(delta_seconds, _frame_contributions);
    double elapsed_ms = 0.0;
    bool clear_active_plan = false;

    if (_active_parameter_plan) {
      auto& plan = *_active_parameter_plan;
      elapsed_ms = (now - plan.started_at) * 1000.0;
      bool all_activated = true;
      for (const auto& binding : plan.bindings) {
        all_activated &= elapsed_ms >= binding.activation_at_ms;
      }
      if (plan.release_started_at_ms < 0.0
          && all_activated
          && elapsed_ms >= plan.duration_ms - plan.blend_out_ms) {
        plan.release_started_at_ms = elapsed_ms;
      }

      float ownership = 1.0f;
      if (plan.release_started_at_ms >= 0.0) {
        if (plan.blend_out_ms <= 0
            || elapsed_ms >= plan.release_started_at_ms + plan.blend_out_ms) {
          ownership = 0.0f;
        } else {
          const auto progress = static_cast<float>(
              (elapsed_ms - plan.release_started_at_ms) / plan.blend_out_ms);
          ownership = Smoothstep(1.0f - progress);
        }
      }

      for (auto& binding : plan.bindings) {
        if (elapsed_ms < binding.activation_at_ms) {
          continue;
        }
        auto frame_target = motion::ResolveTrack(
            binding.keyframes, elapsed_ms, binding.target_value);
        if (!binding.modulation_points.empty()
            && binding.modulation_amplitude > 0.0f) {
          const auto gesture = motion::ResolveTrack(
              binding.modulation_points,
              std::max(0.0, elapsed_ms - binding.modulation_delay_ms),
              0.0f);
          frame_target += gesture * binding.modulation_amplitude
              * static_cast<float>(binding.modulation_direction)
              * services_.audio.speech_audio_gain(binding.axis_id);
        }
        _frame_contributions.push_back(ParameterFrameContribution{
            binding.parameter_id,
            binding.parameter_index,
            ParameterContributionOwner::DirectPlan,
            binding.axis_id,
            frame_target,
            binding.weight * ownership,
            100,
            &binding.presentation,
            true,
            elapsed_ms});
      }
      clear_active_plan = plan.release_started_at_ms >= 0.0
          && elapsed_ms >= plan.release_started_at_ms + plan.blend_out_ms;
    }

    if (!std::isfinite(lip_sync_intensity)
        || lip_sync_intensity < 0.0f || lip_sync_intensity > 1.0f) {
      std::cerr << "[parameter_mixer] lip sync intensity invalid\n";
      fail_active_parameter_plan("lip_sync_intensity_invalid");
      return false;
    }
    if (lip_sync_active) {
      for (const auto parameter_index : _model->LipSyncParameterIndices()) {
        if (parameter_index < 0
            || parameter_index >= cubism_model->GetParameterCount()) {
          std::cerr << "[parameter_mixer] lip sync parameter is not writable\n";
          fail_active_parameter_plan("lip_sync_parameter_not_writable");
          return false;
        }
        const auto minimum = cubism_model->GetParameterMinimumValue(
            static_cast<csmUint32>(parameter_index));
        const auto default_value = cubism_model->GetParameterDefaultValue(
            static_cast<csmUint32>(parameter_index));
        const auto maximum = cubism_model->GetParameterMaximumValue(
            static_cast<csmUint32>(parameter_index));
        if (!std::isfinite(minimum) || !std::isfinite(default_value)
            || !std::isfinite(maximum) || minimum > default_value
            || default_value >= maximum) {
          std::cerr << "[parameter_mixer] lip sync parameter range invalid: "
                    << ParameterIdAt(parameter_index) << '\n';
          fail_active_parameter_plan("lip_sync_parameter_range_invalid");
          return false;
        }
        _frame_contributions.push_back(ParameterFrameContribution{
            ParameterIdAt(parameter_index),
            parameter_index,
            ParameterContributionOwner::LipSync,
            "lip_sync",
            default_value + (maximum - default_value) * lip_sync_intensity,
            1.0f,
            200,
            nullptr,
            false,
            elapsed_ms});
      }
    }

    bool direct_presentation_settled = true;
    if (!ResolveAndWriteParameterFrame(
            _frame_contributions, direct_presentation_settled)) {
      fail_active_parameter_plan("parameter_frame_rejected");
      return false;
    }
    if (clear_active_plan && direct_presentation_settled) {
      QueueMotionTerminalLocked(
          _active_parameter_plan->clock, true);
      _active_parameter_plan.reset();
    }
    return true;
  }

  bool ResolveAndWriteParameterFrame(
      std::vector<ParameterFrameContribution>& contributions,
      bool& direct_presentation_settled) {
    auto* model = _model ? _model->GetModel() : nullptr;
    if (!model) {
      return false;
    }
    if (contributions.empty()) {
      return true;
    }

    const auto reject = [](const std::string& reason) {
      std::cerr << "[parameter_mixer] " << reason << '\n';
      return false;
    };
    for (std::size_t index = 0; index < _frame_group_count; ++index) {
      _frame_groups[index].contributions.clear();
    }
    _frame_group_count = 0;
    _frame_group_by_index.clear();
    _frame_resolved_values.clear();
    auto& groups = _frame_groups;
    auto& group_by_index = _frame_group_by_index;
    for (auto& contribution : contributions) {
      if (contribution.parameter_id.empty()) {
        return reject("parameter_id_missing");
      }
      if (contribution.parameter_index < 0
          || contribution.parameter_index >= model->GetParameterCount()) {
        return reject(
            "parameter_index_invalid:" + std::string(contribution.parameter_id));
      }
      if (contribution.source.empty() || !std::isfinite(contribution.value)
          || !std::isfinite(contribution.weight)
          || contribution.weight < 0.0f || contribution.weight > 1.0f) {
        return reject(
            "contribution_invalid:" + std::string(contribution.parameter_id));
      }

      const auto [found, inserted] = group_by_index.emplace(
          contribution.parameter_index, _frame_group_count);
      if (inserted) {
        if (_frame_group_count == groups.size()) {
          groups.emplace_back();
        }
        auto& new_group = groups[_frame_group_count++];
        new_group.parameter_index = contribution.parameter_index;
        new_group.parameter_id = contribution.parameter_id;
        new_group.contributions.clear();
        new_group.snapshot = {};
      }
      auto& group = groups[found->second];
      if (group.parameter_id != contribution.parameter_id) {
        return reject(
            "parameter_identity_conflict:" + std::string(group.parameter_id)
            + ":" + std::string(contribution.parameter_id));
      }
      group.contributions.push_back(&contribution);
    }

    std::sort(
        groups.begin(), groups.begin() + _frame_group_count,
        [](const auto& left, const auto& right) {
      return left.parameter_index < right.parameter_index;
    });
    for (std::size_t group_index = 0;
         group_index < _frame_group_count;
         ++group_index) {
      auto& group = groups[group_index];
      const auto actual_parameter_id = ParameterIdAt(group.parameter_index);
      if (actual_parameter_id.empty()
          || actual_parameter_id != group.parameter_id) {
        return reject(
            "parameter_identity_mismatch:" + std::string(group.parameter_id));
      }
      const auto index = static_cast<csmUint32>(group.parameter_index);
      group.snapshot = ParameterFrameSnapshot{
          actual_parameter_id,
          model->GetParameterValue(group.parameter_index),
          model->GetParameterMinimumValue(index),
          model->GetParameterMaximumValue(index)};
      if (!std::isfinite(group.snapshot.base_value)
          || !std::isfinite(group.snapshot.minimum_value)
          || !std::isfinite(group.snapshot.maximum_value)
          || group.snapshot.minimum_value > group.snapshot.maximum_value) {
        return reject(
            "runtime_range_or_base_invalid:" + std::string(group.parameter_id));
      }
      std::stable_sort(
          group.contributions.begin(),
          group.contributions.end(),
          [](const auto* left, const auto* right) {
            if (left->priority != right->priority) {
              return left->priority < right->priority;
            }
            return left->source < right->source;
          });
    }

    auto& resolved_values = _frame_resolved_values;
    resolved_values.reserve(_frame_group_count);
    for (std::size_t group_index = 0;
         group_index < _frame_group_count;
         ++group_index) {
      auto& group = groups[group_index];
      const auto base_value = group.snapshot.base_value;
      auto mixed_target = base_value;
      auto direct_only_target = base_value;
      bool has_lip_sync = false;
      ParameterPresentationState* presentation_state = nullptr;
      bool presentation_is_direct_plan = false;
      double presentation_elapsed_ms = 0.0;
      for (const auto* contribution : group.contributions) {
        mixed_target = mixed_target * (1.0f - contribution->weight)
            + contribution->value * contribution->weight;
        if (contribution->owner == ParameterContributionOwner::LipSync) {
          has_lip_sync = true;
        } else {
          direct_only_target = direct_only_target * (1.0f - contribution->weight)
              + contribution->value * contribution->weight;
          if (contribution->presentation) {
            presentation_state = contribution->presentation;
            presentation_is_direct_plan = contribution->presentation_is_direct_plan;
            presentation_elapsed_ms = contribution->elapsed_ms;
          }
        }
      }

      auto final_value = has_lip_sync ? mixed_target : direct_only_target;
      if (presentation_state) {
        auto& presentation = *presentation_state;
        const auto target = ResolveEnvelopeTarget(
            presentation,
            direct_only_target,
            presentation_elapsed_ms,
            presentation_is_direct_plan && _active_parameter_plan
                ? &*_active_parameter_plan : nullptr);
        const auto target_offset = target - base_value;
        if (presentation.last_elapsed_ms < 0.0) {
          presentation.last_elapsed_ms = presentation_elapsed_ms;
        } else if (presentation_elapsed_ms > presentation.last_elapsed_ms) {
          const auto delta_seconds = static_cast<float>(
              (presentation_elapsed_ms - presentation.last_elapsed_ms) / 1000.0);
          const auto next_state = presentation.response_kind == "spring"
              ? motion::AdvanceSpring(
                  presentation.driven_offset,
                  target_offset,
                  presentation.velocity,
                  delta_seconds,
                  presentation.max_velocity,
                  presentation.max_acceleration,
                  presentation.response_frequency_hz,
                  presentation.response_damping_ratio)
              : motion::AdvanceBounded(
                  presentation.driven_offset,
                  target_offset,
                  presentation.velocity,
                  delta_seconds,
                  presentation.max_velocity,
                  presentation.max_acceleration);
          presentation.velocity = next_state.velocity;
          presentation.driven_offset = next_state.value;
          presentation.last_elapsed_ms = presentation_elapsed_ms;
        }
        if (!has_lip_sync) {
          final_value = base_value + presentation.driven_offset;
        }
        const bool settled = std::abs(presentation.driven_offset - target_offset) <= 0.001f
            && std::abs(presentation.velocity) <= 0.001f;
        if (presentation_is_direct_plan) {
          direct_presentation_settled &= settled;
        }
      }

      if (!std::isfinite(final_value)) {
        return reject(
            "resolved_value_invalid:" + std::string(group.parameter_id));
      }
      resolved_values.emplace_back(
          group.parameter_index,
          std::clamp(
              final_value,
              group.snapshot.minimum_value,
              group.snapshot.maximum_value));
    }

    for (const auto& [parameter_index, value] : resolved_values) {
      model->SetParameterValue(parameter_index, value);
      const auto readback = model->GetParameterValue(parameter_index);
      if (!std::isfinite(readback) || std::abs(readback - value) > 0.001f) {
        return reject(
            "write_mismatch:" + std::string(ParameterIdAt(parameter_index)));
      }
    }
    return true;
  }

  static std::string SelectedModelName(
      const ag99::runtime::Json& model_sync_payload) {
    const auto model_info = model_sync_payload.find("model_info");
    return model_info != model_sync_payload.end() && model_info->is_object()
        ? json::ReadString(*model_info, "selected_model")
        : std::string{};
  }

  static const ag99::runtime::Json* SelectedModelProfile(
      const ag99::runtime::Json& model_sync_payload) {
    const auto model_info = model_sync_payload.find("model_info");
    if (model_info == model_sync_payload.end() || !model_info->is_object()) {
      return nullptr;
    }
    const auto models = model_info->find("models");
    if (models == model_info->end() || !models->is_array()) {
      return nullptr;
    }
    const auto selected = json::ReadString(*model_info, "selected_model");
    for (const auto& model : *models) {
      if (!model.is_object()) {
        continue;
      }
      if (!selected.empty() && json::ReadString(model, "name") != selected) {
        continue;
      }
      const auto profile = model.find("semantic_axis_profile");
      if (profile != model.end() && profile->is_object()) {
        return &*profile;
      }
    }
    return nullptr;
  }

  const ag99::runtime::Json* SelectedModelProfile() const {
    return SelectedModelProfile(_model_sync_payload);
  }

  static std::optional<std::array<double, 2>> ReadNumberPair(
      const ag99::runtime::Json& object,
      const char* key) {
    const auto it = object.find(key);
    if (it == object.end() || !it->is_array() || it->size() != 2
        || !(*it)[0].is_number() || !(*it)[1].is_number()) {
      return std::nullopt;
    }
    const std::array<double, 2> result{
        (*it)[0].get<double>(), (*it)[1].get<double>()};
    if (!std::isfinite(result[0]) || !std::isfinite(result[1])) {
      return std::nullopt;
    }
    return result;
  }

  static std::string LowerAscii(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
      return static_cast<char>(std::tolower(ch));
    });
    return value;
  }

  static std::string TrimAscii(std::string value) {
    const auto not_space = [](unsigned char ch) {
      return std::isspace(ch) == 0;
    };
    const auto first = std::find_if(value.begin(), value.end(), not_space);
    const auto last = std::find_if(value.rbegin(), value.rend(), not_space).base();
    return first < last ? std::string(first, last) : std::string{};
  }

  static int InteractionAxisPriority(
      const ag99::runtime::Json& axis,
      bool gaze) {
    const auto id = LowerAscii(json::ReadString(axis, "id"));
    const auto text = id + " " + LowerAscii(json::ReadString(axis, "label")) + " "
        + LowerAscii(json::ReadString(axis, "description")) + " "
        + LowerAscii(json::ReadString(axis, "usage_notes"));
    if (gaze) {
      if (id == "gaze_x") return 0;
      if (id == "head_yaw") return 1;
      for (const auto* token : {"gaze", "视线", "眼神", "扭头", "yaw"}) {
        if (text.find(token) != std::string::npos) return 2;
      }
      return -1;
    }
    if (id == "gaze_x" || id == "head_yaw") return 0;
    if (id == "head_roll") return 1;
    if (id == "body_yaw" || id == "body_roll") return 2;
    for (const auto* token : {
             "gaze", "yaw", "roll", "左右", "扭头", "摇摆"}) {
      if (text.find(token) != std::string::npos) return 3;
    }
    return -1;
  }

  const ag99::runtime::Json* SelectInteractionAxis(bool gaze) const {
    const auto* profile = SelectedModelProfile();
    if (!profile) {
      return nullptr;
    }
    const auto axes = profile->find("axes");
    if (axes == profile->end() || !axes->is_array()) {
      return nullptr;
    }
    const ag99::runtime::Json* selected = nullptr;
    int selected_priority = std::numeric_limits<int>::max();
    for (const auto& axis : *axes) {
      if (!axis.is_object()) {
        continue;
      }
      const auto role = json::ReadString(axis, "control_role");
      const auto anchors = axis.find("level_anchors");
      const auto bindings = axis.find("parameter_bindings");
      if ((role != "primary" && role != "hint")
          || anchors == axis.end() || !anchors->is_object()
          || !anchors->contains("-1") || !anchors->contains("1")
          || !anchors->at("-1").is_number()
          || !anchors->at("1").is_number()
          || bindings == axis.end() || !bindings->is_array()
          || bindings->empty()) {
        continue;
      }
      const int priority = InteractionAxisPriority(axis, gaze);
      if (priority >= 0 && priority < selected_priority) {
        selected = &axis;
        selected_priority = priority;
      }
    }
    return selected;
  }

  std::optional<std::vector<InteractionBinding>> CreateInteractionBindings(
      const ag99::runtime::Json& axis,
      double negative_axis_value,
      double positive_axis_value) const {
    auto* model = _model ? _model->GetModel() : nullptr;
    if (!model) {
      return std::nullopt;
    }
    const auto axis_id = json::ReadString(axis, "id");
    const auto neutral = axis.find("neutral");
    const auto dynamics = axis.find("dynamics");
    const auto bindings = axis.find("parameter_bindings");
    if (axis_id.empty() || neutral == axis.end() || !neutral->is_number()
        || !std::isfinite(neutral->get<double>())
        || dynamics == axis.end() || !dynamics->is_object()
        || bindings == axis.end() || !bindings->is_array()
        || bindings->empty()) {
      return std::nullopt;
    }
    const auto neutral_value = neutral->get<double>();
    const auto axis_max_velocity = dynamics->find("max_velocity");
    const auto axis_max_acceleration = dynamics->find("max_acceleration");
    if (axis_max_velocity == dynamics->end() || !axis_max_velocity->is_number()
        || axis_max_acceleration == dynamics->end()
        || !axis_max_acceleration->is_number()) {
      return std::nullopt;
    }

    const auto semantic_group = TrimAscii(
        LowerAscii(json::ReadString(axis, "semantic_group")));
    float response_frequency_hz = 0.0f;
    float response_damping_ratio = 0.0f;
    bool use_spring = true;
    if (semantic_group == "head") {
      response_frequency_hz = 2.9f;
      response_damping_ratio = 0.72f;
    } else if (semantic_group == "body") {
      response_frequency_hz = 1.05f;
      response_damping_ratio = 0.84f;
    } else if (semantic_group == "torso") {
      response_frequency_hz = 1.0f;
      response_damping_ratio = 0.86f;
    } else if (semantic_group == "shoulder") {
      response_frequency_hz = 1.08f;
      response_damping_ratio = 0.84f;
    } else if (semantic_group == "gaze") {
      response_frequency_hz = 4.2f;
      response_damping_ratio = 0.74f;
    } else if (semantic_group == "eye") {
      response_frequency_hz = 4.4f;
      response_damping_ratio = 0.86f;
    } else if (semantic_group == "brow") {
      response_frequency_hz = 3.9f;
      response_damping_ratio = 0.78f;
    } else if (semantic_group == "face") {
      response_frequency_hz = 3.6f;
      response_damping_ratio = 0.78f;
    } else {
      use_spring = false;
    }

    const auto map_binding_value = [&](const ag99::runtime::Json& binding,
                                       double value,
                                       double& target,
                                       double& neutral_target) {
      const auto input_range = ReadNumberPair(binding, "input_range");
      const auto output_range = ReadNumberPair(binding, "output_range");
      const auto invert = binding.find("invert");
      if (!input_range || !output_range
          || (*input_range)[0] == (*input_range)[1]
          || value < (*input_range)[0] || value > (*input_range)[1]
          || !std::isfinite(neutral_value)
          || (invert != binding.end() && !invert->is_boolean())) {
        return false;
      }
      const auto ratio = (value - (*input_range)[0])
          / ((*input_range)[1] - (*input_range)[0]);
      const bool inverted = invert != binding.end() && invert->get<bool>();
      const auto effective_ratio = inverted ? 1.0 - ratio : ratio;
      target = (*output_range)[0]
          + ((*output_range)[1] - (*output_range)[0]) * effective_ratio;
      const auto neutral_ratio = (neutral_value - (*input_range)[0])
          / ((*input_range)[1] - (*input_range)[0]);
      const auto effective_neutral_ratio = inverted
          ? 1.0 - neutral_ratio : neutral_ratio;
      neutral_target = (*output_range)[0]
          + ((*output_range)[1] - (*output_range)[0])
              * effective_neutral_ratio;
      return std::isfinite(target) && std::isfinite(neutral_target);
    };

    std::vector<InteractionBinding> result;
    result.reserve(bindings->size());
    std::unordered_set<csmInt32> seen_parameter_indices;
    for (const auto& binding : *bindings) {
      if (!binding.is_object()) {
        return std::nullopt;
      }
      const auto parameter_id = TrimAscii(json::ReadString(binding, "parameter_id"));
      const auto weight_it = binding.find("default_weight");
      if (parameter_id.empty() || weight_it == binding.end()
          || !weight_it->is_number()) {
        return std::nullopt;
      }
      const auto weight = weight_it->get<double>();
      if (!std::isfinite(weight) || weight < 0.0 || weight > 1.0) {
        return std::nullopt;
      }
      double mapped_neutral = 0.0;
      double neutral_again = 0.0;
      double mapped_negative = 0.0;
      double negative_neutral = 0.0;
      double mapped_positive = 0.0;
      double positive_neutral = 0.0;
      if (!map_binding_value(binding, neutral_value, mapped_neutral, neutral_again)
          || !map_binding_value(
              binding, negative_axis_value, mapped_negative, negative_neutral)
          || !map_binding_value(
              binding, positive_axis_value, mapped_positive, positive_neutral)
          || std::abs(mapped_neutral - neutral_again) > 1e-6
          || std::abs(mapped_neutral - negative_neutral) > 1e-6
          || std::abs(mapped_neutral - positive_neutral) > 1e-6) {
        return std::nullopt;
      }
      const auto parameter_id_handle =
          CubismFramework::GetIdManager()->GetId(parameter_id.c_str());
      const auto parameter_index = model->GetParameterIndex(parameter_id_handle);
      if (parameter_index < 0
          || !seen_parameter_indices.insert(parameter_index).second) {
        return std::nullopt;
      }
      const auto index = static_cast<csmUint32>(parameter_index);
      const auto minimum = model->GetParameterMinimumValue(index);
      const auto maximum = model->GetParameterMaximumValue(index);
      const auto input_range = ReadNumberPair(binding, "input_range");
      const auto output_range = ReadNumberPair(binding, "output_range");
      if (!input_range || !output_range
          || !std::isfinite(minimum) || !std::isfinite(maximum)
          || minimum > maximum
          || mapped_neutral < minimum || mapped_neutral > maximum
          || mapped_negative < minimum || mapped_negative > maximum
          || mapped_positive < minimum || mapped_positive > maximum) {
        return std::nullopt;
      }
      const double input_span = std::abs((*input_range)[1] - (*input_range)[0]);
      if (input_span <= 0.0) {
        return std::nullopt;
      }
      const double output_per_input = std::abs(
          (*output_range)[1] - (*output_range)[0]) / input_span;
      const double max_velocity = axis_max_velocity->get<double>() * output_per_input;
      const double max_acceleration =
          axis_max_acceleration->get<double>() * output_per_input;
      if (!std::isfinite(max_velocity) || !std::isfinite(max_acceleration)
          || max_velocity <= 0.0 || max_acceleration <= 0.0) {
        return std::nullopt;
      }

      ParameterPresentationState presentation;
      presentation.initial_value = model->GetParameterValue(parameter_index);
      presentation.neutral_value = static_cast<float>(mapped_neutral);
      presentation.max_velocity = static_cast<float>(max_velocity);
      presentation.max_acceleration = static_cast<float>(max_acceleration);
      presentation.response_kind = use_spring ? "spring" : "bounded";
      presentation.response_frequency_hz = response_frequency_hz;
      presentation.response_damping_ratio = response_damping_ratio;
      result.push_back(InteractionBinding{
          axis_id,
          parameter_id,
          parameter_index,
          static_cast<float>(mapped_neutral),
          static_cast<float>(mapped_negative),
          static_cast<float>(mapped_positive),
          static_cast<float>(weight),
          std::move(presentation)});
    }
    return result.empty()
        ? std::nullopt
        : std::optional<std::vector<InteractionBinding>>(std::move(result));
  }

  std::optional<InteractionSwayState> CreateInteractionSway(
      const std::string& turn_id) const {
    const auto* axis = SelectInteractionAxis(false);
    if (!axis) {
      return std::nullopt;
    }
    const auto anchors = axis->find("level_anchors");
    auto bindings = CreateInteractionBindings(
        *axis,
        anchors->at("-1").get<double>(),
        anchors->at("1").get<double>());
    if (!bindings) {
      return std::nullopt;
    }
    return InteractionSwayState{
        turn_id,
        4000.0,
        500.0,
        650.0,
        0.0,
        std::nullopt,
        std::move(*bindings)};
  }

  std::optional<InteractionGazeState> CreateInteractionGaze(
      double target_ratio) const {
    const auto* axis = SelectInteractionAxis(true);
    if (!axis) {
      return std::nullopt;
    }
    const auto anchors = axis->find("level_anchors");
    auto bindings = CreateInteractionBindings(
        *axis,
        anchors->at("-1").get<double>(),
        anchors->at("1").get<double>());
    if (!bindings) {
      return std::nullopt;
    }
    return InteractionGazeState{
        std::clamp(target_ratio, -1.0, 1.0),
        0.0,
        std::move(*bindings)};
  }

  std::optional<MotionPlan> CompileMotionPlan(
      const ag99::runtime::OutputSegment& segment,
      const NativeSegmentClock& clock) const {
    const auto* profile = SelectedModelProfile();
    auto* model = _model ? _model->GetModel() : nullptr;
    if (!profile || !model) {
      return std::nullopt;
    }
    const motion::MotionCompileContext context{
        profile,
        _settings.Snapshot().motion_intensity_scale,
        [model](std::string_view parameter_id) {
          const auto id = CubismFramework::GetIdManager()->GetId(
              std::string(parameter_id).c_str());
          return static_cast<std::int32_t>(model->GetParameterIndex(id));
        }};
    return motion::CompileMotionPlan(segment, clock, context);
  }

  void ApplyQueuedMotion(double now) {
    std::scoped_lock lock(_motion_mutex);
    if (!_model || !_model->GetModel()) {
      return;
    }
    if (_motion_scheduler.pending_motion_segment) {
      const auto clock = _motion_scheduler.pending_motion_clock.value_or(
          NativeSegmentClock{
              .turn_id = _motion_scheduler.pending_motion_segment->envelope.turn_id.value_or(""),
              .message_id = _motion_scheduler.pending_motion_segment->envelope.message_id,
              .sequence = _motion_scheduler.pending_motion_segment->sequence,
              .started_at_seconds = now,
              .generation = _connection_generation});
      std::optional<MotionPlan> plan;
      try {
        plan = CompileMotionPlan(
            *_motion_scheduler.pending_motion_segment, clock);
      } catch (const std::exception& error) {
        std::cerr << "[motion] compile threw " << typeid(error).name()
                  << ": " << error.what() << '\n';
      } catch (...) {
        std::cerr << "[motion] compile threw an unknown exception\n";
      }
      const auto turn_id =
          _motion_scheduler.pending_motion_segment->envelope.turn_id.value_or("");
      _motion_scheduler.pending_motion_segment.reset();
      _motion_scheduler.pending_motion_clock.reset();
      if (plan) {
        _motion_scheduler.active_motion = *plan;
        ReleaseThinkingSwayLocked(turn_id);
        std::cerr << "[motion] compiled "
                  << _motion_scheduler.active_motion->tracks.size()
                  << " parameter tracks for "
                  << _motion_scheduler.active_motion->duration_ms << " ms\n";
      } else {
        QueueMotionTerminalLocked(clock, false, "motion_plan_rejected");
      }
    }
    if (!_motion_scheduler.active_motion) {
      return;
    }
    const double elapsed_ms =
        (now - _motion_scheduler.active_motion->started_at) * 1000.0;
    for (const auto& track : _motion_scheduler.active_motion->tracks) {
      if (track.keyframes.empty()) {
        continue;
      }
      const double value = motion::EvaluateTrackValue(
          *_motion_scheduler.active_motion, track, elapsed_ms);
      const double minimum = _model->GetModel()->GetParameterMinimumValue(
          track.parameter_index);
      const double maximum = _model->GetModel()->GetParameterMaximumValue(
          track.parameter_index);
      _model->GetModel()->SetParameterValue(
          track.parameter_index,
          static_cast<csmFloat32>(Clamp(value, minimum, maximum)));
    }
    if (elapsed_ms >= _motion_scheduler.active_motion->duration_ms) {
      QueueMotionTerminalLocked(
          _motion_scheduler.active_motion->clock, true);
      _motion_scheduler.active_motion.reset();
    }
  }

  void ApplyPreActionMotion(double now) {
    std::scoped_lock lock(_motion_mutex);
    if (!_pre_action_motion || !_model || !_model->GetModel()) {
      return;
    }
    const double elapsed_ms =
        (now - _pre_action_motion->started_at) * 1000.0;
    for (const auto& track : _pre_action_motion->tracks) {
      if (track.keyframes.empty()) {
        continue;
      }
      const double value = motion::EvaluateTrackValue(
          *_pre_action_motion, track, elapsed_ms);
      const double minimum = _model->GetModel()->GetParameterMinimumValue(
          track.parameter_index);
      const double maximum = _model->GetModel()->GetParameterMaximumValue(
          track.parameter_index);
      _model->GetModel()->SetParameterValue(
          track.parameter_index,
          static_cast<csmFloat32>(Clamp(value, minimum, maximum)));
    }
    if (elapsed_ms >= _pre_action_motion->duration_ms) {
      _pre_action_motion.reset();
    }
  }

  NativeModelServices services_;
  NativeCubismModel* _model = nullptr;
  CubismModelSettingJson* _setting = nullptr;
  ag99::live2d::D3D11Renderer _renderer;
  std::vector<std::string> _parameter_ids;
  std::vector<ParameterFrameContribution> _frame_contributions;
  std::vector<ParameterFrameGroup> _frame_groups;
  std::size_t _frame_group_count = 0;
  std::unordered_map<csmInt32, std::size_t> _frame_group_by_index;
  std::vector<std::pair<csmInt32, float>> _frame_resolved_values;
  UINT _width = 0;
  UINT _height = 0;
  double _last_update_seconds = 0.0;
  ag99::runtime::Json _model_sync_payload = ag99::runtime::Json::object();
  std::optional<ParameterPlan> _active_parameter_plan;
  std::optional<MotionPlan> _pre_action_motion;
  std::optional<ag99::runtime::OutputSegment> _pending_parameter_plan;
  std::optional<NativeSegmentClock> _pending_parameter_clock;
  MotionScheduler _motion_scheduler;
  std::uint64_t _connection_generation = 0;
  std::optional<std::unordered_set<std::string>>
      _pending_physics_response_protected_parameter_ids;
  ag99::native::SettingsController _settings;
  csmFloat32 _model_view_base_scale_x = 1.0f;
  csmFloat32 _model_view_base_scale_y = 1.0f;
  csmFloat32 _model_view_base_translate_x = 0.0f;
  csmFloat32 _model_view_base_translate_y = 0.0f;
  bool _pending_model_view_settings = false;
  std::optional<double> _pending_physics_response_scale;
  std::optional<std::string> _pending_thinking_turn_id;
  std::optional<InteractionSwayState> _interaction_sway;
  std::optional<InteractionGazeState> _interaction_gaze;
  double _next_cursor_poll_ms = 0.0;
  double _gaze_candidate_x = 0.0;
  double _gaze_candidate_y = 0.0;
  double _gaze_candidate_since_ms = 0.0;
  bool _gaze_candidate_valid = false;
  mutable std::mutex _motion_mutex;
};



NativeModel::NativeModel(NativeModelServices services)
    : impl_(std::make_unique<Impl>(std::move(services))) {}

NativeModel::~NativeModel() = default;

bool NativeModel::Load(
    const std::filesystem::path& model_json,
    UINT width,
    UINT height,
    ID3D11Device* device,
    ID3D11DeviceContext* context) {
  return impl_->Load(model_json, width, height, device, context);
}

void NativeModel::UpdateAndDraw() { impl_->UpdateAndDraw(); }
void NativeModel::Resize(UINT width, UINT height) {
  impl_->Resize(width, height);
}
void NativeModel::UpdateCursorGaze(HWND window) { impl_->UpdateCursorGaze(window); }
void NativeModel::QueueOutputSegment(
    ag99::runtime::OutputSegment segment,
    std::optional<NativeSegmentClock> clock) {
  impl_->QueueOutputSegment(std::move(segment), std::move(clock));
}
std::vector<NativeSegmentTerminal> NativeModel::TakeMotionTerminals() {
  return impl_->TakeMotionTerminals();
}
void NativeModel::ResetRuntimeSegments(std::uint64_t generation) {
  impl_->ResetRuntimeSegments(generation);
}
void NativeModel::StartThinkingSway(const std::string& turn_id) {
  impl_->StartThinkingSway(turn_id);
}
void NativeModel::ReleaseThinkingSway(const std::string& turn_id) {
  impl_->ReleaseThinkingSway(turn_id);
}
bool NativeModel::StartPreAction(
    const ag99::runtime::PreActionEvent& event) {
  return impl_->StartPreAction(event);
}
void NativeModel::CancelPreAction(
    const std::string& turn_id,
    const std::string& request_id) {
  impl_->CancelPreAction(turn_id, request_id);
}
void NativeModel::CancelTurn(const std::string& turn_id) {
  impl_->CancelTurn(turn_id);
}
void NativeModel::SetModelSync(const ag99::runtime::Json& payload) {
  impl_->SetModelSync(payload);
}
ag99::runtime::DesktopSettingsResult NativeModel::HandleDesktopSettingsQuery(
    const ag99::runtime::DesktopSettingsQuery& query) {
  return impl_->HandleDesktopSettingsQuery(query);
}
}  // namespace ag99::native
