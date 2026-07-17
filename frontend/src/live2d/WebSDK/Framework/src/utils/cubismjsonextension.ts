/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import {
  JsonArray,
  JsonBoolean,
  JsonFloat,
  JsonCompatibleObject,
  JsonCompatibleValue,
  JsonMap,
  JsonNullvalue,
  JsonString,
  Value
} from './cubismjson';

/**
 * CubismJsonで実装されているJsonパーサを使用せず、
 * TypeScript標準のJsonパーサなどを使用し出力された結果を
 * Cubism SDKで定義されているJSONエレメントの要素に
 * 置き換える処理をするクラス。
 */
export class CubismJsonExtension {
  static parseJsonObject(obj: JsonCompatibleObject, map: JsonMap): JsonMap {
    Object.entries(obj).forEach(([key, value]) => {
      map.put(key, CubismJsonExtension.convertJsonValue(value));
    });
    return map;
  }

  protected static parseJsonArray(obj: JsonCompatibleValue[]): JsonArray {
    const arr = new JsonArray();
    obj.forEach((value) => {
      arr.add(CubismJsonExtension.convertJsonValue(value));
    });
    return arr;
  }

  private static convertJsonValue(value: JsonCompatibleValue): Value {
    if (value == null) {
      return new JsonNullvalue();
    }
    if (typeof value == 'boolean') {
      return new JsonBoolean(value);
    }
    if (typeof value == 'string') {
      return new JsonString(value);
    }
    if (typeof value == 'number') {
      return new JsonFloat(value);
    }
    if (Array.isArray(value)) {
      return CubismJsonExtension.parseJsonArray(value);
    }
    return CubismJsonExtension.parseJsonObject(value, new JsonMap());
  }
}
