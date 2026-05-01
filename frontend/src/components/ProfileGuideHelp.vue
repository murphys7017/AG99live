<script setup lang="ts">
import {
  PROFILE_QUICK_START,
  PROFILE_ROLE_GUIDE,
  PROFILE_FIELD_GUIDE,
} from "../data/profileEditorGuide";
</script>

<template>
  <section class="profile-editor__help">
    <div class="profile-editor__help-block">
      <strong>先看这三个概念</strong>
      <ul class="profile-editor__help-list">
        <li
          v-for="item in PROFILE_QUICK_START"
          :key="item"
        >
          {{ item }}
        </li>
      </ul>
    </div>

    <div class="profile-editor__help-block">
      <strong>Control Role 怎么选</strong>
      <ul class="profile-editor__help-list">
        <li
          v-for="item in PROFILE_ROLE_GUIDE"
          :key="item.role"
        >
          <code>{{ item.role }}</code>：{{ item.description }}
        </li>
      </ul>
    </div>

    <div class="profile-editor__help-block">
      <strong>字段含义</strong>
      <ul class="profile-editor__help-list">
        <li
          v-for="item in PROFILE_FIELD_GUIDE"
          :key="item.label"
        >
          <code>{{ item.label }}</code>：{{ item.description }}
        </li>
      </ul>
    </div>
  </section>
</template>
