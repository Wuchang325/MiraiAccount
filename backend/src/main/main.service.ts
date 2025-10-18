import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

@Injectable()
export class MainService {
  indexGet() {
    return {
      code: 233,
      msg: '哇哦？',
      data: [
        {
          id: 1,
          name: 'MiraiNebula Studio',
          info: 'Author',
        },
      ],
    };
  }
  indexPost() {
    return {
      code: 500,
      msg: '嗯哼？',
      data: [
        {
          id: 1,
          name: 'MiraiNebula Studio',
          info: 'Author',
        },
      ],
    };
  }
  indexAll() {
    throw new HttpException(
      {
        msg: 'EMMMMMM....................',
      },
      HttpStatus.METHOD_NOT_ALLOWED,
    );
  }
}
