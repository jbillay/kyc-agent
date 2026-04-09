<script setup>
import AppSidebar from './AppSidebar.vue';
import AppHeader from './AppHeader.vue';
</script>

<template>
  <div class="app-layout">
    <AppSidebar />
    <div class="app-main">
      <AppHeader />
      <div class="app-content">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: row;
  min-height: 100vh;
}

.app-main {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.app-content {
  overflow-y: auto;
  padding: 1.5rem;
}
</style>
