<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '@/components/layout/AppLayout.vue';

const route = useRoute();
const useLayout = computed(() => route.meta.requiresAuth === true);
</script>

<template>
  <AppLayout v-if="useLayout">
    <RouterView />
  </AppLayout>
  <RouterView v-else />
</template>
