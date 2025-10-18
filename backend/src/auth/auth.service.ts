import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { db } from 'src/Service/mysql';
import bcrypt from 'bcryptjs';
import { timeUuid } from 'src/Utils/uuid';
import { logger } from 'src/Utils/log';
import type { LoginForm, RegForm } from './auth.interface';
import { MailCodeType, MailLinkType } from './auth.interface';
import type { UserInfo } from 'src/user/user.interface';
import { base64ToUint8Array, emailTemplate, isEmail } from 'src/Utils';
import type { Request } from 'express';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  GenerateAuthenticationOptionsOpts,
  VerifiedAuthenticationResponse,
  VerifyAuthenticationResponseOpts,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import type {
  AuthenticatorDevice,
  AuthenticationResponseJSON,
} from '@simplewebauthn/types';
import config from 'src/Service/config';
import { City } from 'ipip-ipdb';
import useragent from 'express-useragent';

@Injectable()
export class AuthService {
  // 登录
  async login(session: Record<string, any>, req: Request, body: LoginForm) {
    const a = await this.loginValidateData(body);
    if (!a.status) {
      throw new HttpException(
        {
          msg: '用户名或密码不符合规范',
        },
        HttpStatus.EXPECTATION_FAILED,
      );
    }
    let r: UserInfo;
    if (a.type === 'default') {
      [r] = await db.query('select * from user where binary username=?', [
        body.username,
      ]);
    } else {
      [r] = await db.query('select * from user where binary email=?', [
        body.username,
      ]);
    }

    // 如果没有找到这个用户或者用户名密码错误
    if (r === undefined || !bcrypt.compareSync(body.password, r.password))
      throw new HttpException(
        {
          msg: '用户名或密码错误',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    return await this.loginInfo(session, req, r);
  }

  // 检查邮箱可用性
  async checkEmail(body: { email: string }) {
    // 邮箱格式不正确
    isEmail(body.email);

    // 查询邮箱是否被占用
    const e: UserInfo[] = await db.query(
      'select * from user where binary email=?',
      [body.email],
    );

    // 邮箱已存在在
    if (e[0] != undefined) throw new Error('该邮箱已被注册！');

    // 邮箱可用
    return {
      code: HttpStatus.OK,
      msg: '恭喜，该邮箱可用~',
      time: Date.now(),
    };
  }

  // 检查用户名可用性
  async checkUserName(body: { username: string }) {
    const [r]: UserInfo[] = await db.query(
      'select * from user where binary username=?',
      [body.username],
    );
    if (r != undefined) throw new Error('该用户名已被占用！');

    return {
      code: HttpStatus.OK,
      msg: '恭喜，该用户名可用~',
      time: Date.now(),
    };
  }

  // 本不应该出现在这里
  private async hasUser(usernameOrEmail: string) {
    let r: UserInfo;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usernameOrEmail)) {
      // 是邮箱
      [r] = await db.query(
        'select * from user where binary email=?',
        `${usernameOrEmail}`,
      );
    } else {
      // 用户名
      [r] = await db.query(
        'select * from user where binary username=?',
        `${usernameOrEmail}`,
      );
    }
    if (!r) throw new Error('用户不存在');
    return r;
  }

  // 注册
  async register(session: Record<string, any>, body: RegForm) {
    // 1. 检查是否允许注册
    await this.allowReg();

    // 2. 检查传进来的数据是否合法（用户名/密码格式）
    const isDataValid = await this.regValidateData(body);
    if (!isDataValid) {
      throw new HttpException(
        { msg: '用户名或密码不符合规范' },
        HttpStatus.EXPECTATION_FAILED,
      );
    }

    // 3. 验证邮箱/用户名是否已被占用
    await this.checkEmail({ email: body.email });
    await this.checkUserName({ username: body.username });

    // 4. 验证注册验证码
    await this.verifyEmailCode(session, body.email, body.code, 'reg');

    // 5. 关键修改：查询当前用户总数，判断是否为第一个注册用户
    let isFirstUser = false;
    try {
      // 查询用户表总记录数
      const [userCountResult] = await db.query(
        'SELECT COUNT(*) AS count FROM user',
      );
      // 不同数据库驱动返回格式可能有差异，此处兼容常见格式（取第一个结果的count值）
      const totalUser = Number(
        userCountResult?.count || userCountResult[0]?.count || 0,
      );
      isFirstUser = totalUser === 0; // 总用户数为0 → 第一个用户
    } catch (err) {
      logger.error('查询用户总数失败：', err.message);
      throw new Error('注册流程异常，请联系网站管理员');
    }

    // 6. 插入新用户（根据是否为第一个用户动态设置角色）
    let insertResult; // 优化变量名：原i → insertResult，更具语义
    const userRole = isFirstUser ? 'admin' : 'default'; // 第一个用户设为admin，其余为default
    try {
      insertResult = await db.query(
        'insert into user (username,password,email,status,role,regTime) values (?,?,?,?,?,?)',
        [
          body.username,
          bcrypt.hashSync(body.password, 10), // 密码加密存储
          body.email,
          0, // status字段默认值（按原有逻辑保留）
          userRole, // 动态角色
          Date.now(), // 注册时间戳
        ],
      );
    } catch (err) {
      logger.error('插入新用户失败：', err.message);
      throw new Error('注册失败，请联系网站管理员');
    }

    // 7. 验证插入结果，成功则写入每日统计
    if (insertResult.affectedRows === 1) {
      const formattedDate = new Date().toISOString().split('T')[0]; // 格式：YYYY-MM-DD
      await db.query(
        'INSERT INTO daily_statistics (date, count) VALUES (?, 1) ON DUPLICATE KEY UPDATE count = count + 1',
        [formattedDate],
      );

      return {
        code: HttpStatus.OK,
        msg: isFirstUser
          ? '好耶！你是第一个注册用户，已自动获得管理员权限~'
          : '好耶，你注册成功了~', // 给管理员用户特殊提示
        time: Date.now(),
      };
    } else {
      throw new Error('注册失败，请联系网站管理员');
    }
  }

  // 登出
  async logout(session: Record<string, any>) {
    if (!session.login) throw new Error('登出失败，你tm是不是没登录？');
    session.destroy();
    return {
      code: HttpStatus.OK,
      msg: '登出成功',
      time: Date.now(),
    };
  }

  // 生成 外部验证器 配置项
  async genAuthOpt(session: Record<string, any>, body: LoginForm) {
    const u = await this.hasUser(body.username);

    const devices: AuthenticatorDevice[] = u.authDevice
      ? JSON.parse(u.authDevice)
      : [];

    const opts: GenerateAuthenticationOptionsOpts = {
      timeout: 60000,
      allowCredentials: devices.map((dev: any) => ({
        id: base64ToUint8Array(dev.credentialID),
        type: 'public-key',
        transports: dev.transports,
      })),
      userVerification: 'preferred',
      rpID: config.webAuthn.rpID,
    };

    const options = await generateAuthenticationOptions(opts);
    session['NyaChallenge'] = options.challenge;
    session['_uname'] = u.username;

    return {
      code: HttpStatus.OK,
      msg: '获取成功',
      time: Date.now(),
      data: options,
    };
  }

  // 验证外部验证器
  async vRegOpt(
    session: Record<string, any>,
    req: Request,
    body: AuthenticationResponseJSON,
  ) {
    const u = await this.hasUser(session['_uname']);

    const devices: AuthenticatorDevice[] = u.authDevice
      ? JSON.parse(u.authDevice)
      : [];

    let dbAuthenticator;
    const bodyCredIDBuffer = isoBase64URL.toBuffer(body.rawId);
    for (const dev of devices) {
      if (
        isoUint8Array.areEqual(
          base64ToUint8Array(dev.credentialID as any),
          bodyCredIDBuffer,
        )
      ) {
        dbAuthenticator = dev;
        break;
      }
    }
    if (!dbAuthenticator) throw new Error('非法的验证器');

    let verification: VerifiedAuthenticationResponse;
    try {
      const opts: VerifyAuthenticationResponseOpts = {
        response: body,
        expectedChallenge: session['NyaChallenge'],
        expectedOrigin: config.webAuthn.expectedOrigin,
        expectedRPID: config.webAuthn.rpID,
        authenticator: {
          credentialID: base64ToUint8Array(dbAuthenticator.credentialID as any),
          credentialPublicKey: base64ToUint8Array(
            dbAuthenticator.credentialPublicKey as any,
          ),
          counter: dbAuthenticator.counter,
        },
        requireUserVerification: false,
      };
      verification = await verifyAuthenticationResponse(opts);
    } catch (err: any) {
      console.error(err);
      throw new Error(err.message);
    }

    const { verified } = verification;
    session['_uname'] = session['NyaChallenge'] = undefined;

    if (!verified) throw new Error('验证失败');

    return await this.loginInfo(session, req, u);
  }

  async loginInfo(session: Record<string, any>, req: Request, u: UserInfo) {
    // 如果被封了
    if (u.status == -1)
      throw new Error('你已被封禁，禁止登录。详情请联系管理员');

    // 登录成功
    // 记录登录IP
    const { ip, loginTime } = await this.recordLoginIP(req, u);

    // 删除密码再发送给客户端
    delete u.password;
    delete u.verifyToken;
    u.authDevice
      ? (u.authDevice = JSON.parse(u.authDevice).map((obj: any) => ({
          credentialID: obj.credentialID,
        })))
      : (u.authDevice = null);

    session['login'] = true;
    session['uid'] = u.id;
    session['email'] = u.email;

    return {
      code: HttpStatus.OK,
      msg: '登录成功',
      time: Date.now(),
      data: {
        ...u,
        lastLoginIp: ip,
        lastLoginTime: loginTime,
      },
    };
  }

  // 创建验证邮箱验证码
  async createVerifyEmailCode(
    session: Record<string, any>,
    receiver: string,
    type: string,
  ) {
    // 验证验证码类型
    if (!type || MailCodeType.findIndex((i) => i === type) === -1)
      throw new Error('未知的验证码类型');

    if (type !== 'reg') {
      if (session && !session.login) throw new Error('你tm是不是没登录？');
    }

    // 验证邮箱格式
    isEmail(receiver);

    // 生成6位数验证码
    const verifyCode = Math.random().toString().slice(3, 9).toUpperCase();
    session[type] = {
      email: receiver,
      code: verifyCode,
      expire: Date.now() + 60 * 5000, // 5min之后过期
    };

    const email = {
      to: receiver, // 发给谁？
      subject: 'Mirai | 邮箱验证', // 邮件标题
      html: await emailTemplate(type, verifyCode),
    };

    return email;
  }

  // 验证邮箱验证码（新用户注册，更改密码）
  async verifyEmailCode(
    session: Record<string, any>,
    email: string,
    code: string,
    type: string,
  ) {
    // 验证验证码类型
    if (!type || MailCodeType.findIndex((i) => i === type) === -1)
      throw new Error('未知的验证码类型');

    if (!session[type]) throw new Error('验证码不正确');
    if (email !== session[type].email) throw new Error('邮箱不对应！');
    if (code != session[type].code) throw new Error('验证码不正确');
    if (Date.now() > session[type].expire) {
      session[type] = null;
      throw new Error('该验证码已过期，请重新获取');
    }
    session[type] = null;
    return {
      code: HttpStatus.OK,
      msg: '验证码验证成功！',
      time: Date.now(),
    };
  }

  // 创建验证邮箱验证地址
  async createVerifyEmail(receiver: string, type: string) {
    // 验证验证码类型
    if (!type || MailLinkType.findIndex((i) => i === type) === -1)
      throw new Error('未知的验证码类型');

    // 验证邮箱格式
    isEmail(receiver);

    // 判断这个邮箱是否被注册
    const [u]: UserInfo[] = await db.query(
      'select * from user where binary email=?',
      [receiver],
    );
    if (!u) throw new Error('该邮箱未注册');

    // 如果有，那就生成验证链接，以及把uuid存入数据库后面进行比对
    const t_uuid = timeUuid();

    const r = await db.query('update user set verifyToken=? where id=?', [
      t_uuid,
      u.id,
    ]);
    if (r.affectedRows !== 1) throw new Error('恭喜，数据库没了');

    const email = {
      to: receiver,
      subject: 'Mirai | 邮箱验证',
      html: await emailTemplate(type, t_uuid),
    };
    return email;
  }

  // 验证邮箱地址（适用于忘记密码）
  async verifyEmailLink(body: { code: string }) {
    // 首先判断和数据库里面的是否相符
    const [dc] = await db.query(
      'select id from user where binary verifyToken=?',
      body.code,
    );
    if (!dc) throw new Error('验证链接已过期或不存在！');

    // 取出code里面的时间
    const date2 = Number(
      body.code.substring(body.code.length - 13, body.code.length),
    );
    const date1 = new Date().getTime();

    // 算出已经过去了10分钟没有
    const d = Math.floor(Math.abs(date2 - date1) / 60000);
    if (d > 10) {
      await db.query('update user set verifyToken=? where id=?', [null, dc.id]);
      throw new Error('验证链接已过期！');
    }

    // 没有？那就是验证成功了
    await db.query('update user set verifyToken=? where id=?', [null, dc.id]);

    return {
      code: HttpStatus.OK,
      msg: '邮箱验证成功！',
      time: Date.now(),
    };
  }

  // 重置密码
  async resetPasswd(body: Pick<RegForm, 'password'> & Pick<RegForm, 'code'>) {
    // 先验证密码是否合法
    const a = /^[a-zA-Z0-9!@#$%^&*()_+\-=[\]{}|\\:;"'<>,.?/~`]{6,20}$/.test(
      body.password,
    );
    if (!a) {
      throw new HttpException(
        {
          msg: '新密码不符合规范！',
        },
        HttpStatus.EXPECTATION_FAILED,
      );
    }

    // 获取被重置密码的邮箱
    const [dc]: { email: string }[] = await db.query(
      'select email from user where binary verifyToken=?',
      body.code,
    );
    if (!dc) throw new Error('验证链接已过期或不存在！');
    const thisEmail = dc.email;

    // 验证重置地址是否过期
    await this.verifyEmailLink(body);

    // OK，开始更新密码
    const r = await db.query('update user set password=? where email=?', [
      bcrypt.hashSync(body.password, 10),
      thisEmail,
    ]);

    if (r.affectedRows !== 1)
      throw new Error('发生了未知错误，请联系网站管理员');

    return {
      code: HttpStatus.OK,
      msg: '密码重置成功',
      time: Date.now(),
    };
  }

  // 登录表单验证，顺便判断是用户名还是邮箱登录
  async loginValidateData(body: LoginForm) {
    const uname = body.username;
    const passwd = body.password;

    if (!uname || !passwd)
      throw new HttpException(
        {
          msg: '请填写表单完整',
        },
        HttpStatus.EXPECTATION_FAILED,
      );

    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(uname)) {
      return {
        status:
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(uname) &&
          /^[a-zA-Z0-9!@#$%^&*()_+\-=[\]{}|\\:;"'<>,.?/~`]{6,20}$/.test(passwd),
        type: 'email',
      };
    } else {
      return {
        status:
          /^[a-zA-Z0-9_-]{4,16}$/.test(uname) &&
          /^[a-zA-Z0-9!@#$%^&*()_+\-=[\]{}|\\:;"'<>,.?/~`]{6,20}$/.test(passwd),
        type: 'default',
      };
    }
  }

  // 注册表单验证
  async regValidateData(body: RegForm) {
    const uname = body.username;
    const passwd = body.password;
    const email = body.email;
    const code = body.code;

    if (!uname || !passwd || !email || !code)
      throw new HttpException(
        {
          msg: '请填写表单完整',
        },
        HttpStatus.EXPECTATION_FAILED,
      );

    // 判断禁止的用户名
    if (uname === 'admin')
      throw new HttpException(
        {
          msg: '禁止该用户名',
        },
        HttpStatus.EXPECTATION_FAILED,
      );

    // 邮箱格式不正确
    isEmail(email);

    return (
      /^[a-zA-Z0-9_-]{4,16}$/.test(uname) &&
      /^[a-zA-Z0-9!@#$%^&*()_+\-=[\]{}|\\:;"'<>,.?/~`]{6,20}$/.test(passwd)
    );
  }

  // 是否允许注册
  async allowReg() {
    const a = await db.query(
      'select * from site where binary optionName = "allowReg"',
    );
    if (a[0].value === 'false') {
      throw new HttpException(
        {
          msg: '本站已关闭用户注册功能！',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    } else {
      return true;
    }
  }

  parseCity(info: Record<string, string>) {
    const l = [];

    l.push(info.countryName);

    if (info.regionName !== info.countryName) l.push(info.regionName);
    if (info.cityName) l.push(info.cityName);

    return l.join('-');
  }

  // 记录登录IP
  async recordLoginIP(req: Request, u: UserInfo) {
    const ip = config.isCdn
      ? (req.headers['x-forwarded-for'] as string).split(',')[0]
      : config.isReverseProxy
        ? req.headers['x-real-ip']
        : req.socket.remoteAddress;
    const loginTime = new Date();

    let city;

    if (!config.ipip.enable || ip.includes(':')) {
      city = 'Unknown';
    } else {
      const c = new City(config.ipip.dbPath);
      const i = c.findInfo(ip, 'CN');
      city = this.parseCity(i);
    }
    const ua = useragent.parse(req.headers['user-agent']);
    const device = `${ua.os} / ${ua.browser} ${ua.version}`;

    await db.query(
      'insert into user_ip (uid,ip,location,device,time) values(?,?,?,?,?)',
      [u.id, ip, city, device, loginTime],
    );

    return {
      ip,
      loginTime,
    };
  }
}
