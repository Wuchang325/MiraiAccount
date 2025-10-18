<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { indexStore } from '@/stores'
import { LoginForm } from '@/types'
import { VForm } from 'vuetify/lib/components/index.mjs'
import { loginApi } from '@/apis/auth'
import { userStore } from '@/stores/user'
import router from '@/router'
import { useDisplay } from 'vuetify'
import { useRouteQuery } from '@vueuse/router'

const { xs } = useDisplay()
const { showMsg, isLogin } = indexStore()
const { info } = storeToRefs(userStore())
const redirectUrl = useRouteQuery('redirect')

const form = ref<InstanceType<typeof VForm>>()
const formData = ref<LoginForm>({ username: '', password: '' })
const step = ref(1)
const btnLoading = ref(false)

const nextStep = () => formData.value.username && step.value++

const login = async () => {
  if (!form.value) return
  const { valid } = await form.value.validate()
  if (!valid) return
  btnLoading.value = true
  try {
    const { msg, data } = await loginApi(formData.value)
    showMsg(msg, 'green')
    info.value = data
    isLogin.value = true
    if (redirectUrl.value) {
      window.location.href = decodeURIComponent(redirectUrl.value as string)
      return
    }
    router.replace('/user/info')
  } finally {
    btnLoading.value = false
  }
}
</script>

<template>
  <v-form ref="form" fast-fail @submit.prevent>
    <!-- 动效输入区 -->
    <v-slide-y-reverse-transition leave-absolute>
      <div v-if="step === 2 && formData.username" class="text-center mt-n3 mb-2">
        <v-chip prepend-icon="mdi-account-circle-outline" color="primary">
          {{ formData.username }}
        </v-chip>
      </div>
    </v-slide-y-reverse-transition>

    <v-slide-x-transition leave-absolute>
      <v-text-field
        v-if="step === 1"
        v-model="formData.username"
        autofocus
        label="用户名或邮箱"
        :rules="[(v: any) => !!(v && v.length) || '请输入用户名']"
      />
      <v-text-field
        v-else
        v-model="formData.password"
        autofocus
        label="密码"
        type="password"
        :rules="[(v: any) => !!(v && v.length) || '请输入密码']"
      />
    </v-slide-x-transition>

    <div class="mt-1 mb-3 text-body-2 text--secondary">
      没有账户？
      <router-link to="/auth/register" class="text-primary text-decoration-none">
        去注册吧！
      </router-link>
    </div>

    <v-row v-if="step === 1">
      <v-col cols="12" sm="7">
        <v-row>
          <v-col cols="12" sm="6">
            <v-btn size="large" variant="text" color="primary" block to="/auth/reset">
              忘记密码
            </v-btn>
          </v-col>
        </v-row>
      </v-col>
      <v-col cols="12" sm="5">
        <v-btn size="large" color="primary" type="submit" block @click="nextStep"> 下一步 </v-btn>
      </v-col>
    </v-row>

    <v-row v-else>
      <v-col cols="12" sm="6">
        <v-row>
          <v-col cols="12" sm="6">
            <v-btn size="large" variant="text" color="warning" block @click="step--">
              上一步
            </v-btn>
          </v-col>
          <v-col v-if="!xs" cols="12" sm="6" />
        </v-row>
      </v-col>
      <v-col cols="12" sm="6">
        <v-btn
          size="large"
          color="primary"
          type="submit"
          block
          :loading="btnLoading"
          @click="login"
        >
          登录
        </v-btn>
      </v-col>
    </v-row>
  </v-form>
</template>
