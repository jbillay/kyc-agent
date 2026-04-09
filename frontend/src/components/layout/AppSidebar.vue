<script setup>
// AppSidebar — navigation
</script>

<template>
  <aside class="app-sidebar">
    <nav>
      <RouterLink to="/dashboard">Dashboard</RouterLink>
      <RouterLink to="/review">Review Queue</RouterLink>
      <RouterLink to="/admin/config">Config</RouterLink>
      <RouterLink to="/login">Login</RouterLink>
    </nav>
  </aside>
</template>

<style scoped>
.app-sidebar {
  width: 220px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 1rem;
}

.app-sidebar nav {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
</style>
