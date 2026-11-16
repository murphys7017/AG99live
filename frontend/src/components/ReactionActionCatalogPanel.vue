<script setup lang="ts">
import { REACTION_ACTION_CATALOG } from "../model-engine/ambient/reactionActionCatalog.js";
</script>

<template>
  <article class="reaction-catalog settings-card settings-card--wide">
    <div class="settings-card__header">
      <div>
        <p class="settings-card__eyebrow">动作设计库</p>
        <h2>预设计反应动作</h2>
      </div>
      <span class="settings-card__badge">{{ REACTION_ACTION_CATALOG.length }} templates</span>
    </div>
    <p class="settings-card__copy">
      这些动作使用语义轴和阶段时序描述，运行时会根据当前模型 Profile 解析成具体参数。
      鼠标、桌面变化、等待和对话间隙都可以复用同一套动作模板。
    </p>
    <div class="reaction-catalog__grid">
      <article v-for="action in REACTION_ACTION_CATALOG" :key="action.id" class="reaction-catalog__item">
        <div class="reaction-catalog__item-header">
          <strong>{{ action.label }}</strong>
          <code>{{ action.id }}</code>
        </div>
        <p>{{ action.description }}</p>
        <div class="reaction-catalog__meta">
          <span>{{ action.emotionLabel }}</span>
          <span>{{ action.durationMs }} ms</span>
          <span>{{ action.semanticGroups.join(" / ") }}</span>
        </div>
        <small>触发 {{ action.triggers.join("、") }}</small>
      </article>
    </div>
  </article>
</template>

<style scoped>
.reaction-catalog__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.reaction-catalog__item {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 12px;
  padding: 14px;
  background: rgba(15, 23, 42, 0.42);
}

.reaction-catalog__item-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.reaction-catalog__item-header code {
  color: #94a3b8;
  font-size: 11px;
}

.reaction-catalog__item p {
  min-height: 42px;
  margin: 9px 0;
  color: #cbd5e1;
  font-size: 13px;
  line-height: 1.55;
}

.reaction-catalog__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  color: #a7f3d0;
  font-size: 11px;
}

.reaction-catalog__meta span {
  padding: 3px 7px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.12);
}

.reaction-catalog__item small {
  display: block;
  margin-top: 9px;
  color: #94a3b8;
}
</style>
