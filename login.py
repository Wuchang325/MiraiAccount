import webbrowser
import secrets
import threading
import time
from typing import Optional, Dict
from flask import Flask, request

class OAuthClient:
    def __init__(self):
        self.client_id = "9"
        self.redirect_uri = "http://localhost:8000/callback"
        self.state = secrets.token_urlsafe(16)
        self.code_holder: Dict[str, Optional[str]] = {'code': None, 'error': None}
        self.app = Flask(__name__)
        self.setup_routes()
        
    def setup_routes(self) -> None:
        """设置Flask路由"""
        @self.app.route('/callback')
        def callback():
            """OAuth回调处理"""
            code = request.args.get('code')
            error = request.args.get('error')
            state_param = request.args.get('state')
            
            if error:
                self.code_holder['error'] = error
                return f"授权错误: {error}", 400
            
            if state_param != self.state:
                self.code_holder['error'] = "state_mismatch"
                return "状态不匹配", 400
            
            if not code:
                self.code_holder['error'] = "missing_code"
                return "缺少授权码", 400
            
            print(f"✅ 成功获取授权码: {code}")
            self.code_holder['code'] = code
            return "授权码获取成功！您可以关闭此窗口。", 200

    def get_authorization_url(self) -> str:
        """生成授权URL"""
        base_url = "http://127.0.0.1:1240/oauth2/authorize"
        params = {
            "client_id": self.client_id,
            "response_type": "code",
            "state": self.state,
            "redirect_uri": self.redirect_uri
        }
        query_string = "&".join([f"{k}={v}" for k, v in params.items()])
        return f"{base_url}?{query_string}"

    def run_flask_server(self) -> None:
        """运行Flask服务器"""
        print("🚀 启动OAuth回调服务器...")
        self.app.run(port=8000, debug=False, use_reloader=False)

    def wait_for_code(self, timeout: int = 120) -> Optional[str]:
        """等待获取授权码"""
        print(f"⏳ 等待授权回调 (超时时间: {timeout}秒)...")
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            if self.code_holder['code'] is not None:
                return self.code_holder['code']
            if self.code_holder['error'] is not None:
                print(f"❌ 发生错误: {self.code_holder['error']}")
                return None
            time.sleep(0.5)
        
        print("❌ 等待授权码超时")
        return None

    def get_authorization_code(self) -> Optional[str]:
        """获取授权码的主流程"""
        # 生成授权URL
        auth_url = self.get_authorization_url()
        print(f"🔗 授权URL: {auth_url}")
        
        # 在后台启动Flask服务器
        server_thread = threading.Thread(target=self.run_flask_server, daemon=True)
        server_thread.start()
        
        # 等待服务器启动
        time.sleep(2)
        
        # 打开浏览器进行授权
        print("🌐 打开浏览器进行授权...")
        webbrowser.open(auth_url)
        
        # 等待授权码
        code = self.wait_for_code()
        return code

def main():
    """主函数"""
    print("🔐 开始OAuth 2.0授权流程 - 仅获取授权码")
    
    client = OAuthClient()
    code = client.get_authorization_code()
    
    if code:
        print(f"🎉 成功获取授权码: {code}")
        print("✅ 授权码获取流程完成")
    else:
        print("❌ 授权码获取失败")

if __name__ == '__main__':
    main()